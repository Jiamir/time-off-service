/**
 * Mock HCM Server
 *
 * A lightweight Express server that simulates an HCM system (Workday/SAP-like).
 * Used by integration and E2E tests to exercise real HTTP flows without a
 * live HCM dependency.
 *
 * WHY a real HTTP server instead of Jest mocks:
 * Jest module mocks bypass the actual axios client code. A real server lets
 * us test timeout handling, malformed responses, and network errors with full
 * HTTP fidelity — all of which are explicitly called out in the spec.
 *
 * Endpoints:
 *   GET  /hcm/balance/:employeeId/:locationId  — real-time balance lookup
 *   POST /hcm/deduct                           — submit a balance deduction
 *   POST /hcm/admin/set-balance                — test control: set a balance directly
 *   POST /hcm/admin/set-error-mode             — test control: force errors/timeouts
 *   POST /hcm/admin/reset                      — test control: reset to seed state
 *   GET  /hcm/admin/state                      — test control: inspect current state
 */

const express = require('express');

// ---------------------------------------------------------------------------
// Seed data — initial balances loaded when the server starts
// ---------------------------------------------------------------------------
const SEED_BALANCES = {
  'ali-khan:lahore':          18,
  'sara-ahmed:lahore':        12,
  'usman-malik:karachi':      22,
  'ayesha-raza:karachi':       8,
  'bilal-chaudhry:islamabad': 15,
  'emp-1:loc-1':              20,
  'test-emp:test-loc':        20,
};

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
let balances = { ...SEED_BALANCES };

/**
 * Error mode controls per (employeeId, locationId) or globally.
 *
 * Shape: {
 *   global: null | 'timeout' | 'server_error' | 'bad_json',
 *   perKey: { 'emp_001:loc_us_pto': 'timeout' | 'insufficient' | 'server_error' }
 * }
 *
 * WHY per-key error modes: lets us simulate HCM failing for one employee
 * while still serving others normally — e.g., test that batch sync isolates
 * failures correctly.
 */
let errorMode = {
  global: null,
  perKey: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(employeeId, locationId) {
  return `${employeeId}:${locationId}`;
}

function resolveErrorMode(employeeId, locationId) {
  const k = key(employeeId, locationId);
  return errorMode.perKey[k] || errorMode.global || null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// HCM business endpoints
// ---------------------------------------------------------------------------

/**
 * GET /hcm/balance/:employeeId/:locationId
 * Returns the current HCM balance for one employee/location.
 */
app.get('/hcm/balance/:employeeId/:locationId', async (req, res) => {
  const { employeeId, locationId } = req.params;
  const mode = resolveErrorMode(employeeId, locationId);

  if (mode === 'timeout') {
    await delay(30_000);   // outlasts any reasonable HCM_TIMEOUT_MS
    return;
  }
  if (mode === 'server_error') {
    return res.status(500).json({ message: 'HCM internal error (simulated)' });
  }
  if (mode === 'bad_json') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send('{ this is: not valid json }');
  }

  const k       = key(employeeId, locationId);
  const balance = balances[k];

  if (balance === undefined) {
    return res.status(404).json({
      message: `No balance record found for ${employeeId} at ${locationId}`,
    });
  }

  return res.status(200).json({ employeeId, locationId, balance });
});

/**
 * POST /hcm/deduct
 * Body: { employeeId, locationId, days }
 *
 * Submits a balance deduction. HCM validates balance and either confirms
 * (200) or rejects (422 for insufficient balance).
 */
app.post('/hcm/deduct', async (req, res) => {
  const { employeeId, locationId, days } = req.body;

  if (!employeeId || !locationId || days === undefined) {
    return res.status(400).json({
      message: 'employeeId, locationId, and days are required',
    });
  }

  const mode = resolveErrorMode(employeeId, locationId);

  if (mode === 'timeout') {
    await delay(30_000);
    return;
  }
  if (mode === 'server_error') {
    return res.status(500).json({ message: 'HCM internal error (simulated)' });
  }
  if (mode === 'insufficient') {
    return res.status(422).json({
      message: `Insufficient balance for ${employeeId} at ${locationId}`,
    });
  }

  const k       = key(employeeId, locationId);
  const current = balances[k];

  if (current === undefined) {
    return res.status(404).json({
      message: `No balance record for ${employeeId}/${locationId}`,
    });
  }

  if (current < days) {
    return res.status(422).json({
      message: `Insufficient balance: requested ${days}, available ${current}`,
    });
  }

  balances[k] = current - days;

  return res.status(200).json({
    success:      true,
    employeeId,
    locationId,
    daysDeducted: days,
    newBalance:   balances[k],
  });
});

// ---------------------------------------------------------------------------
// Admin / test-control endpoints
// ---------------------------------------------------------------------------

/**
 * POST /hcm/admin/set-balance
 * Simulates out-of-band changes (anniversary bonus, year-start reset).
 */
app.post('/hcm/admin/set-balance', (req, res) => {
  const { employeeId, locationId, balance } = req.body;

  if (!employeeId || !locationId || balance === undefined) {
    return res.status(400).json({
      message: 'employeeId, locationId, and balance are required',
    });
  }
  if (typeof balance !== 'number' || balance < 0) {
    return res.status(400).json({ message: 'balance must be a non-negative number' });
  }

  balances[key(employeeId, locationId)] = balance;
  return res.status(200).json({ message: 'Balance set', employeeId, locationId, balance });
});

/**
 * POST /hcm/admin/set-error-mode
 * Body: { mode: 'timeout'|'server_error'|'insufficient'|'bad_json'|null,
 *         employeeId?, locationId? }
 */
app.post('/hcm/admin/set-error-mode', (req, res) => {
  const { mode, employeeId, locationId } = req.body;

  const validModes = ['timeout', 'server_error', 'insufficient', 'bad_json', null];
  if (!validModes.includes(mode)) {
    return res.status(400).json({
      message: `mode must be one of: ${validModes.join(', ')}`,
    });
  }

  if (employeeId && locationId) {
    const k = key(employeeId, locationId);
    if (mode === null) {
      delete errorMode.perKey[k];
    } else {
      errorMode.perKey[k] = mode;
    }
  } else {
    errorMode.global = mode;
  }

  return res.status(200).json({ message: 'Error mode set', errorMode });
});

/**
 * POST /hcm/admin/reset
 * Resets all balances to seed data and clears all error modes.
 * Call in beforeEach() to ensure test isolation.
 */
app.post('/hcm/admin/reset', (_req, res) => {
  balances  = { ...SEED_BALANCES };
  errorMode = { global: null, perKey: {} };
  return res.status(200).json({ message: 'Mock HCM reset to seed state' });
});

/**
 * GET /hcm/admin/state
 * Returns full current state — useful for debugging failing tests.
 */
app.get('/hcm/admin/state', (_req, res) => {
  return res.status(200).json({ balances, errorMode });
});

// ---------------------------------------------------------------------------
// Start (only when run directly, not when required by tests)
// ---------------------------------------------------------------------------

const PORT = process.env.MOCK_HCM_PORT || 4000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mock HCM server running on http://localhost:${PORT}`);
    console.log('Seed balances:', SEED_BALANCES);
  });
}

module.exports = { app, SEED_BALANCES };