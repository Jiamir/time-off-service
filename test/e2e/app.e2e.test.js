/**
 * E2E Tests — Full HTTP flows
 *
 * Spins up the complete NestJS application with an in-memory SQLite DB and
 * a real mock HCM server. Tests every endpoint and every documented error
 * code via actual HTTP requests.
 *
 * Setup notes (same pattern as integration tests — see requests-flow.test.js):
 *
 *   1. Mock HCM server starts first to get its port.
 *   2. ALL env vars set before any NestJS module is required.
 *   3. AppModule required after env vars — Node module cache captures
 *      DB_PATH=':memory:' and HCM_BASE_URL at require() time.
 *   4. HttpExceptionFilter re-registered on the test app — Test.createNestApplication()
 *      does not run main.js so global filters must be applied manually.
 *   5. console.error suppressed — HcmService and HttpExceptionFilter log every
 *      error intentionally (TRD §10); in tests correctness is asserted via
 *      HTTP status + body, not console output.
 *
 * Coverage targets (TRD §12 Layer 3):
 *   ✓ Full happy path: submit → approve → balance deducted
 *   ✓ Submit with insufficient balance → 422
 *   ✓ Submit succeeds → HCM balance changes externally → approval fails → 409
 *   ✓ Batch sync received → balances updated → subsequent request reflects new balance
 *   ✓ Cancel a pending request → balance freed
 *   ✓ All error codes exercised: 400, 404, 409, 422, 503
 *   ✓ HCM down → fail closed → 503
 *   ✓ HCM timeout → fail closed → 503
 *   ✓ State machine: all invalid transitions blocked
 */

const request        = require('supertest');
const { Test }       = require('@nestjs/testing');
const { DataSource } = require('typeorm');
const http           = require('http');

// Loaded AFTER env vars are set — do not hoist to module top-level.
let AppModule;
let HttpExceptionFilter;

const { app: mockHcmApp } = require('../../mock-hcm/main');

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let nestApp;
let mockHcmServer;
let mockHcmPort;
let httpServer;
let dataSource;

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Suppress intentional error logs — assertions are on HTTP bodies.
  jest.spyOn(console, 'error').mockImplementation(() => {});

  // ── Step 1: Start mock HCM ────────────────────────────────────────────────
  await new Promise((resolve) => {
    mockHcmServer = http.createServer(mockHcmApp);
    mockHcmServer.listen(0, () => {
      mockHcmPort = mockHcmServer.address().port;
      resolve();
    });
  });

  // ── Step 2: Set env vars before any module is compiled ───────────────────
  process.env.DB_PATH                         = ':memory:';
  process.env.HCM_BASE_URL                    = `http://localhost:${mockHcmPort}`;
  process.env.HCM_TIMEOUT_MS                  = '1500';
  process.env.BALANCE_STALE_THRESHOLD_MINUTES = '0';   // always re-sync from HCM

  // ── Step 3: Require modules after env vars ────────────────────────────────
  ({ AppModule }           = require('../../src/app.module'));
  ({ HttpExceptionFilter } = require('../../src/common/filters/http-exception.filter'));

  // ── Step 4: Compile app ───────────────────────────────────────────────────
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],   // AppModule picks up DB_PATH=':memory:' from env
  }).compile();

  nestApp = moduleRef.createNestApplication();

  // Re-register filter — Test.createNestApplication() does not run main.js.
  nestApp.useGlobalFilters(new HttpExceptionFilter());

  await nestApp.init();
  httpServer = nestApp.getHttpServer();
  dataSource = moduleRef.get(DataSource);
}, 30_000);

afterAll(async () => {
  console.error.mockRestore?.();
  await nestApp?.close();
  await new Promise((resolve) => {
    mockHcmServer.closeAllConnections?.();
    mockHcmServer.close(resolve);
  });
});

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Clear SQLite tables so each test starts from scratch.
  await dataSource.query('DELETE FROM time_off_requests');
  await dataSource.query('DELETE FROM balances');

  // Reset mock HCM to seed state and inject the test employee.
  await request(`http://localhost:${mockHcmPort}`).post('/hcm/admin/reset');
  await request(`http://localhost:${mockHcmPort}`)
    .post('/hcm/admin/set-balance')
    .send({ employeeId: 'ali', locationId: 'lahore', balance: 20 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = { employeeId: 'ali', locationId: 'lahore' };

async function submit(days, overrides = {}) {
  return request(httpServer)
    .post('/time-off-requests')
    .send({
      ...BASE,
      startDate: '2026-08-01',
      endDate:   '2026-08-10',
      days,
      reason:    'E2E test leave',
      ...overrides,
    });
}

async function approve(id) {
  return request(httpServer).patch(`/time-off-requests/${id}/approve`);
}

async function reject(id, reason) {
  return request(httpServer)
    .patch(`/time-off-requests/${id}/reject`)
    .send({ reason });
}

async function cancel(id) {
  return request(httpServer).patch(`/time-off-requests/${id}/cancel`);
}

async function getBalance() {
  return request(httpServer).get('/balances/ali/lahore');
}

async function setHcmMode(mode, emp, loc) {
  const body = { mode };
  if (emp) { body.employeeId = emp; body.locationId = loc; }
  return request(`http://localhost:${mockHcmPort}`)
    .post('/hcm/admin/set-error-mode')
    .send(body);
}

async function setHcmBalance(balance) {
  return request(`http://localhost:${mockHcmPort}`)
    .post('/hcm/admin/set-balance')
    .send({ employeeId: 'ali', locationId: 'lahore', balance });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E — Balance Management', () => {
  it('GET /balances/:emp/:loc → 200 with balance and availableBalance', async () => {
    const res = await getBalance();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      employeeId:       'ali',
      locationId:       'lahore',
      balance:          20,
      availableBalance: 20,
    });
    expect(res.body.lastSyncedAt).toBeDefined();
  });

  it('availableBalance reflects pending requests', async () => {
    await submit(7);

    const res = await getBalance();
    expect(res.body.balance).toBe(20);
    expect(res.body.availableBalance).toBe(13); // 20 - 7
  });

  it('GET /balances for unknown employee → 503 (HCM has no record)', async () => {
    const res = await request(httpServer).get('/balances/nobody/nowhere');
    expect(res.status).toBe(503);
  });
});

describe('E2E — Full Happy Path', () => {
  it('submit → approve → balance deducted end-to-end', async () => {
    // 1. Submit
    const submitRes = await submit(8);
    expect(submitRes.status).toBe(201);
    expect(submitRes.body.status).toBe('PENDING');
    const id = submitRes.body.id;

    // 2. Balance shows reserved days (TRD §9 soft-lock)
    let bal = await getBalance();
    expect(bal.body.availableBalance).toBe(12); // 20 - 8

    // 3. Approve — triggers HCM re-sync and deduction (TRD §8)
    const approveRes = await approve(id);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED');
    expect(approveRes.body.hcmConfirmed).toBe(true);

    // 4. Local shadow balance updated after HCM confirms (TRD §8 step 5)
    bal = await getBalance();
    expect(bal.body.balance).toBe(12); // 20 - 8 deducted
  });
});

describe('E2E — Submit Validation', () => {
  it('returns 422 when requested days exceed available balance', async () => {
    const res = await submit(99);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.message).toContain('Available balance');
  });

  it('returns 400 when days is zero', async () => {
    const res = await submit(0);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DAYS');
  });

  it('returns 400 when startDate is after endDate', async () => {
    const res = await submit(5, { startDate: '2026-08-10', endDate: '2026-08-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DATE_RANGE');
  });
});

describe('E2E — Approval with External HCM Changes', () => {
  it('approval fails (409) when HCM balance drops after submission', async () => {
    const id = (await submit(10)).body.id;

    // Simulate out-of-band HCM balance drop (TRD §4.2 — work anniversary / correction)
    await setHcmBalance(3);

    const res = await approve(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('HCM_BALANCE_INSUFFICIENT');

    // Request auto-transitioned to REJECTED (TRD §8 step 3)
    const get = await request(httpServer).get(`/time-off-requests/${id}`);
    expect(get.body.status).toBe('REJECTED');
  });

  it('approval succeeds after HCM anniversary bonus increases balance', async () => {
    // At 20 days, 25-day request fails
    expect((await submit(25)).status).toBe(422);

    // HCM gives anniversary bonus — balance now 30
    await setHcmBalance(30);

    // Force sync to update local shadow
    await request(httpServer).post('/sync/refresh/ali/lahore');

    // 25-day request now succeeds
    const res = await submit(25);
    expect(res.status).toBe(201);
  });
});

describe('E2E — HCM Defensive Behavior (Fail Closed)', () => {
  it('returns 503 HCM_UNAVAILABLE when HCM is down during approval', async () => {
    const id = (await submit(5)).body.id;

    await setHcmMode('server_error');

    const res = await approve(id);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('HCM_UNAVAILABLE');

    // Request must stay PENDING — no approval without HCM confirmation (TRD §4.3)
    const get = await request(httpServer).get(`/time-off-requests/${id}`);
    expect(get.body.status).toBe('PENDING');
  });

  it('returns 503 HCM_UNAVAILABLE when HCM times out during approval', async () => {
    const id = (await submit(5)).body.id;

    await setHcmMode('timeout');

    const res = await approve(id);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('HCM_UNAVAILABLE');

    const get = await request(httpServer).get(`/time-off-requests/${id}`);
    expect(get.body.status).toBe('PENDING');
  }, 10_000); // extended: waits for HCM_TIMEOUT_MS=1500 to elapse

  it('returns 503 when HCM is down during balance read', async () => {
    await setHcmMode('server_error');

    const res = await getBalance();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('HCM_UNAVAILABLE');
  });
});

describe('E2E — Reject Flow', () => {
  it('returns 200 and REJECTED status with valid reason', async () => {
    const id = (await submit(5)).body.id;

    const res = await reject(id, 'Team is at minimum capacity');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
  });

  it('returns 400 when rejection reason is missing', async () => {
    const id = (await submit(5)).body.id;

    const res = await request(httpServer)
      .patch(`/time-off-requests/${id}/reject`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_REJECTION_REASON');
  });
});

describe('E2E — Cancel Flow', () => {
  it('cancels a PENDING request and restores available balance', async () => {
    const id = (await submit(10)).body.id;

    let bal = await getBalance();
    expect(bal.body.availableBalance).toBe(10); // 20 - 10 reserved

    const res = await cancel(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    // CANCELLED row excluded from reserved sum → available restored (TRD §9)
    bal = await getBalance();
    expect(bal.body.availableBalance).toBe(20);
  });
});

describe('E2E — State Machine Enforcement', () => {
  it('cannot approve an already-APPROVED request', async () => {
    const id = (await submit(5)).body.id;
    await approve(id);

    const res = await approve(id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST_STATE');
  });

  it('cannot approve a REJECTED request', async () => {
    const id = (await submit(5)).body.id;
    await reject(id, 'No budget');

    const res = await approve(id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST_STATE');
  });

  it('cannot cancel a CANCELLED request', async () => {
    const id = (await submit(5)).body.id;
    await cancel(id);

    const res = await cancel(id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST_STATE');
  });

  it('cannot reject a CANCELLED request', async () => {
    const id = (await submit(5)).body.id;
    await cancel(id);

    const res = await reject(id, 'Too late');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST_STATE');
  });
});

describe('E2E — Batch Sync', () => {
  it('POST /sync/batch → 200 with processed/upserted/errors summary', async () => {
    const res = await request(httpServer)
      .post('/sync/batch')
      .send({
        balances: [
          { employeeId: 'ali',  locationId: 'lahore',  balance: 25 },
          { employeeId: 'sara', locationId: 'karachi', balance: 10 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(2);
    expect(res.body.upserted).toBe(2);
    expect(res.body.errors).toHaveLength(0);
  });

  it('subsequent request sees updated balance after batch sync', async () => {
    await request(httpServer)
      .post('/sync/batch')
      .send({ balances: [{ employeeId: 'ali', locationId: 'lahore', balance: 30 }] });

    // Was 20 before sync — 25-day request now succeeds
    const res = await submit(25);
    expect(res.status).toBe(201);
  });

  it('returns 400 for empty balances array', async () => {
    const res = await request(httpServer)
      .post('/sync/batch')
      .send({ balances: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  it('isolates row errors — good rows upserted even if bad rows present', async () => {
    const res = await request(httpServer)
      .post('/sync/batch')
      .send({
        balances: [
          { employeeId: 'ali', locationId: 'lahore', balance: 20 },  // valid
          { employeeId: 'bad', locationId: 'x',      balance: -1 },  // invalid
        ],
      });

    expect(res.body.upserted).toBe(1);
    expect(res.body.errors).toHaveLength(1);
  });
});

describe('E2E — Not Found', () => {
  it('GET /time-off-requests/99999 → 404', async () => {
    const res = await request(httpServer).get('/time-off-requests/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('REQUEST_NOT_FOUND');
  });

  it('PATCH /time-off-requests/99999/approve → 404', async () => {
    const res = await request(httpServer).patch('/time-off-requests/99999/approve');
    expect(res.status).toBe(404);
  });
});