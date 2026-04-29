/**
 * Integration Tests — Request Lifecycle Flow
 *
 * Uses a real SQLite in-memory database + real NestJS app + real mock HCM
 * HTTP server running on a random OS-assigned port.
 *
 * Design decisions:
 *
 *   DB_PATH=':memory:' is set in process.env BEFORE AppModule is compiled.
 *   AppModule reads DB_PATH at TypeOrmModule.forRoot() time, so the env var
 *   must be present before Test.createTestingModule() runs — not after.
 *
 *   The mock HCM server is started first (to get its port), then env vars
 *   are set, then the NestJS app is compiled. Order matters.
 *
 *   app.useGlobalFilters() must be called on the test app instance because
 *   NestJS testing does NOT run main.js — global filters registered there
 *   are invisible to the test app unless re-registered here.
 *
 *   beforeEach deletes all rows from both tables so every test starts from
 *   a clean slate. DROP TABLE is not used because synchronize:true already
 *   created the schema — we only want empty rows, not to destroy structure.
 *
 *   console.error is suppressed for the duration of the suite.
 *   WHY: the HttpExceptionFilter and HcmService intentionally log every
 *   4xx/5xx response to aid production debugging (TRD §10). In tests this
 *   output is noise — correctness is asserted via HTTP status codes and
 *   response bodies, not console output.
 *
 * Coverage targets (TRD §12 Layer 2):
 *   ✓ Submit → balance reduces available days → second request sees reduced balance
 *   ✓ Approve → HCM called → local balance updated
 *   ✓ HCM returns insufficient balance on approval → request auto-REJECTED → 409
 *   ✓ HCM times out on approval → request stays PENDING → 503
 *   ✓ HCM returns 500 on approval → request stays PENDING → 503
 *   ✓ Invalid state transition (REJECTED → APPROVED) → 400
 *   ✓ Reject with reason → 200
 *   ✓ Reject without reason → 400
 *   ✓ Cancel pending request → balance freed → 200
 *   ✓ Cancel already-cancelled request → 400
 *   ✓ Batch sync upserts new and existing balances
 *   ✓ Subsequent request reflects updated balance after batch sync
 *   ✓ Batch sync isolates per-row errors (bad entry does not abort good entries)
 *   ✓ Batch sync rejects empty array → 400
 *   ✓ Sync refresh pulls latest HCM balance → 200
 */

const request        = require('supertest');
const http           = require('http');
const { Test }       = require('@nestjs/testing');
const { DataSource } = require('typeorm');

// Loaded after env vars are set in beforeAll — do NOT hoist to module
// top-level or Node's require cache will capture stale env values.
let AppModule;
let HttpExceptionFilter;

const { app: mockHcmApp } = require('../../mock-hcm/main');

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let mockHcmServer;
let mockHcmPort;
let app;
let dataSource;

// ---------------------------------------------------------------------------
// Suppress console.error for the whole suite
// ---------------------------------------------------------------------------

// Installed in the first beforeAll so it wraps all describe blocks.
// mockRestore() in the matching afterAll returns console.error to normal
// for any test suites that run after this one in the same Jest worker.
let consoleErrorSpy;

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Suppress noisy-but-correct error logs produced by the exception filter
  // and HcmService. Tests assert on HTTP bodies, not console output.
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  // ── Step 1: Start mock HCM on a random port ──────────────────────────────
  // Must happen first so we have the port before setting HCM_BASE_URL.
  await new Promise((resolve) => {
    mockHcmServer = http.createServer(mockHcmApp);
    mockHcmServer.listen(0, () => {
      mockHcmPort = mockHcmServer.address().port;
      resolve();
    });
  });

  // ── Step 2: Set ALL env vars before any NestJS module code runs ───────────
  // AppModule reads DB_PATH and HCM_BASE_URL at module-init time inside
  // TypeOrmModule.forRoot() and HcmService constructor. Setting them here —
  // before Test.createTestingModule() — ensures the test app picks them up.
  process.env.DB_PATH                         = ':memory:';
  process.env.HCM_BASE_URL                    = `http://localhost:${mockHcmPort}`;
  process.env.HCM_TIMEOUT_MS                  = '2000';
  // Force stale threshold to 0 so every getBalance call re-syncs from HCM.
  // WHY: tests mutate HCM state between calls; a cached shadow balance
  // would cause the test to read stale data and produce wrong assertions.
  process.env.BALANCE_STALE_THRESHOLD_MINUTES = '0';

  // ── Step 3: Require app modules AFTER env vars are set ───────────────────
  // Node caches modules on first require(). Hoisting these to the top of
  // the file would cause TypeOrmModule.forRoot() to capture DB_PATH before
  // we set it to ':memory:', making the app open time-off.db instead.
  ({ AppModule }           = require('../../src/app.module'));
  ({ HttpExceptionFilter } = require('../../src/common/filters/http-exception.filter'));

  // ── Step 4: Compile and initialise the NestJS test app ───────────────────
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();

  // Re-register the global exception filter.
  // Test.createNestApplication() does NOT run main.js, so filters registered
  // via app.useGlobalFilters() there are invisible here. Without this every
  // res.body.error assertion would receive NestJS's default "Bad Request"
  // string instead of our custom error codes (e.g. 'INVALID_REQUEST_STATE').
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.init();

  // Retain DataSource so beforeEach can truncate tables between tests.
  dataSource = moduleRef.get(DataSource);
}, 30_000);

afterAll(async () => {
  consoleErrorSpy?.mockRestore();

  await app?.close();

  // closeAllConnections() (Node 18.2+) immediately destroys keep-alive
  // sockets. Without it, open connections hold the event loop alive after
  // close() returns and Jest warns "did not exit one second after the test
  // run has completed."
  await new Promise((resolve) => {
    mockHcmServer.closeAllConnections?.();
    mockHcmServer.close(resolve);
  });
});

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Table names from entity definitions:
  //   balance.entity.js          → tableName: 'balances'
  //   time-off-request.entity.js → tableName: 'time_off_requests'
  // Delete requests first to avoid any implicit ordering issues.
  await dataSource.query('DELETE FROM time_off_requests');
  await dataSource.query('DELETE FROM balances');

  // Restore mock HCM to its seeded state and inject the test employee.
  await request(`http://localhost:${mockHcmPort}`)
    .post('/hcm/admin/reset');

  await request(`http://localhost:${mockHcmPort}`)
    .post('/hcm/admin/set-balance')
    .send({ employeeId: 'test-emp', locationId: 'test-loc', balance: 20 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Submit a time-off request for test-emp / test-loc.
 * `overrides` lets individual tests modify any field without re-specifying
 * the full payload.
 */
async function submitRequest(days = 5, overrides = {}) {
  return request(app.getHttpServer())
    .post('/time-off-requests')
    .send({
      employeeId: 'test-emp',
      locationId: 'test-loc',
      startDate:  '2026-07-01',
      endDate:    '2026-07-05',
      days,
      reason:     'Test leave',
      ...overrides,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration — Request Lifecycle', () => {

  // ── Submit ─────────────────────────────────────────────────────────────────

  describe('Submit', () => {
    it('creates a PENDING request when balance is sufficient', async () => {
      const res = await submitRequest(5);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.id).toBeDefined();
    });

    it('reduces availableBalance after submission (reserved days tracked)', async () => {
      // Submit 5 days — those become PENDING and are soft-locked immediately.
      await submitRequest(5);

      // GET /balances must show 15 available (20 total − 5 reserved).
      // Validates TRD §9: availableBalance = balance − SUM(PENDING+APPROVED).
      const balRes = await request(app.getHttpServer())
        .get('/balances/test-emp/test-loc');

      expect(balRes.status).toBe(200);
      expect(balRes.body.balance).toBe(20);
      expect(balRes.body.availableBalance).toBe(15);
    });

    it('second request sees reduced available balance', async () => {
      await submitRequest(10);   // 10 reserved → 10 remaining

      // Requesting 15 more should fail — only 10 available.
      const res = await submitRequest(15);

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
    });

    it('returns 422 immediately when balance is insufficient (no HCM call)', async () => {
      // 99 days far exceeds the 20-day balance — rejected before HCM is touched.
      const res = await submitRequest(99);

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
    });

    it('returns 400 for invalid date range', async () => {
      const res = await submitRequest(5, {
        startDate: '2026-07-10',
        endDate:   '2026-07-01',   // start is after end
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_DATE_RANGE');
    });
  });

  // ── Approve ────────────────────────────────────────────────────────────────

  describe('Approve', () => {
    it('approves request, calls HCM, and deducts local balance', async () => {
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/approve`);

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.status).toBe('APPROVED');
      expect(approveRes.body.hcmConfirmed).toBe(true);

      // Local shadow balance must reflect the deduction (TRD §8 step 5).
      const balRes = await request(app.getHttpServer())
        .get('/balances/test-emp/test-loc');

      expect(balRes.body.balance).toBe(15);
    });

    it('auto-rejects and returns 409 when HCM balance is insufficient after re-sync', async () => {
      // Submit while balance is 20.
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      // Simulate out-of-band HCM change: balance drops to 2 (TRD §4.2).
      await request(`http://localhost:${mockHcmPort}`)
        .post('/hcm/admin/set-balance')
        .send({ employeeId: 'test-emp', locationId: 'test-loc', balance: 2 });

      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/approve`);

      // TRD §8 step 3 + §10 error taxonomy: HCM_BALANCE_INSUFFICIENT → 409.
      expect(approveRes.status).toBe(409);
      expect(approveRes.body.error).toBe('HCM_BALANCE_INSUFFICIENT');

      // Request must have been auto-transitioned to REJECTED (TRD §8 step 3).
      const getRes = await request(app.getHttpServer())
        .get(`/time-off-requests/${id}`);
      expect(getRes.body.status).toBe('REJECTED');
    });

    it('returns 503 and leaves request PENDING when HCM times out', async () => {
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      // Force HCM to hang — outlasts HCM_TIMEOUT_MS=2000.
      await request(`http://localhost:${mockHcmPort}`)
        .post('/hcm/admin/set-error-mode')
        .send({ mode: 'timeout' });

      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/approve`);

      // TRD §8 Timeout Policy + §10: HCM_UNAVAILABLE → 503.
      expect(approveRes.status).toBe(503);
      expect(approveRes.body.error).toBe('HCM_UNAVAILABLE');

      // Request must NOT have been modified — still PENDING for manager retry.
      const getRes = await request(app.getHttpServer())
        .get(`/time-off-requests/${id}`);
      expect(getRes.body.status).toBe('PENDING');
    }, 10_000); // extended: test waits for HCM_TIMEOUT_MS=2000 to elapse

    it('returns 503 and leaves request PENDING when HCM returns 500', async () => {
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      await request(`http://localhost:${mockHcmPort}`)
        .post('/hcm/admin/set-error-mode')
        .send({ mode: 'server_error' });

      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/approve`);

      expect(approveRes.status).toBe(503);

      const getRes = await request(app.getHttpServer())
        .get(`/time-off-requests/${id}`);
      expect(getRes.body.status).toBe('PENDING');
    });

    it('returns 400 for invalid state transition (REJECTED → APPROVED)', async () => {
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      // Reject first to move request into a terminal state.
      await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/reject`)
        .send({ reason: 'Not approved' });

      // REJECTED has no outgoing transitions (TRD §5 state machine).
      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/approve`);

      expect(approveRes.status).toBe(400);
      expect(approveRes.body.error).toBe('INVALID_REQUEST_STATE');
    });
  });

  // ── Reject ─────────────────────────────────────────────────────────────────

  describe('Reject', () => {
    it('rejects a PENDING request with reason', async () => {
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      const rejectRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/reject`)
        .send({ reason: 'Team understaffed' });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.status).toBe('REJECTED');
    });

    it('returns 400 when rejection reason is missing', async () => {
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      const rejectRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/reject`)
        .send({});   // reason field absent entirely

      expect(rejectRes.status).toBe(400);
      expect(rejectRes.body.error).toBe('MISSING_REJECTION_REASON');
    });
  });

  // ── Cancel ─────────────────────────────────────────────────────────────────

  describe('Cancel', () => {
    it('cancels a PENDING request and frees balance back to available pool', async () => {
      // Submit 10 days → available drops from 20 to 10.
      const submitRes = await submitRequest(10);
      const id = submitRes.body.id;

      let balRes = await request(app.getHttpServer())
        .get('/balances/test-emp/test-loc');
      expect(balRes.body.availableBalance).toBe(10);

      // Cancel → PENDING row excluded from reserved sum → available returns to 20.
      // No explicit balance credit is needed: availableBalance is derived live
      // by subtracting only PENDING+APPROVED rows (TRD §9).
      const cancelRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/cancel`);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.status).toBe('CANCELLED');

      balRes = await request(app.getHttpServer())
        .get('/balances/test-emp/test-loc');
      expect(balRes.body.availableBalance).toBe(20);
    });

    it('returns 400 for invalid transition (CANCELLED → CANCELLED)', async () => {
      const submitRes = await submitRequest(5);
      const id = submitRes.body.id;

      await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/cancel`);

      // Second cancel on a terminal state must be rejected.
      const res = await request(app.getHttpServer())
        .patch(`/time-off-requests/${id}/cancel`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_REQUEST_STATE');
    });
  });

  // ── Batch Sync ─────────────────────────────────────────────────────────────

  describe('Batch Sync', () => {
    it('upserts new and existing balances from HCM batch', async () => {
      const res = await request(app.getHttpServer())
        .post('/sync/batch')
        .send({
          balances: [
            { employeeId: 'test-emp', locationId: 'test-loc', balance: 25 },
            { employeeId: 'new-emp',  locationId: 'test-loc', balance: 10 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.processed).toBe(2);
      expect(res.body.upserted).toBe(2);
      expect(res.body.errors).toHaveLength(0);
    });

    it('subsequent request reflects new balance after batch sync', async () => {
      // Sync balance to 30 — above the default 20-day seed.
      await request(app.getHttpServer())
        .post('/sync/batch')
        .send({
          balances: [{ employeeId: 'test-emp', locationId: 'test-loc', balance: 30 }],
        });

      // A 25-day request that would have failed at 20 must now succeed.
      const res = await submitRequest(25);
      expect(res.status).toBe(201);
    });

    it('isolates errors per row — bad entry does not abort good entries', async () => {
      // Negative balance is invalid; the valid row must still be upserted.
      // TRD §8 Batch Sync Flow: errors are collected per-row, not fatal.
      const res = await request(app.getHttpServer())
        .post('/sync/batch')
        .send({
          balances: [
            { employeeId: 'test-emp', locationId: 'test-loc', balance: 20 },
            { employeeId: 'bad-emp',  locationId: 'test-loc', balance: -5 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.upserted).toBe(1);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].error).toContain('balance must be >= 0');
    });

    it('returns 400 for empty balances array', async () => {
      const res = await request(app.getHttpServer())
        .post('/sync/batch')
        .send({ balances: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_PAYLOAD');
    });
  });

  // ── Sync Refresh ───────────────────────────────────────────────────────────

  describe('Sync Refresh', () => {
    it('returns updated balance after out-of-band HCM change', async () => {
      // Simulate a work-anniversary bonus: HCM now shows 30 (TRD §4.2).
      await request(`http://localhost:${mockHcmPort}`)
        .post('/hcm/admin/set-balance')
        .send({ employeeId: 'test-emp', locationId: 'test-loc', balance: 30 });

      // POST /sync/refresh forces a real-time pull and persists the new value.
      const res = await request(app.getHttpServer())
        .post('/sync/refresh/test-emp/test-loc');

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(30);
      expect(res.body.message).toContain('refreshed');
    });
  });
});