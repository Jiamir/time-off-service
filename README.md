# Time-Off Microservice

A production-quality backend microservice for managing employee time-off request lifecycles, built with **NestJS**, **SQLite**, and **TypeORM**. Designed against the ExampleHR take-home specification.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup & Running](#setup--running)
- [API Reference](#api-reference)
- [Running Tests](#running-tests)
- [Environment Variables](#environment-variables)
- [Design Decisions](#design-decisions)

---

## Overview

The service manages the full lifecycle of a time-off request (submit → approve / reject / cancel) while keeping a local "shadow" copy of HCM balances synchronized with an external Human Capital Management system (analogous to Workday or SAP).

**Core design principles:**

- **Optimistic local check at submission** — employees get instant feedback without waiting for an HCM round-trip.
- **Mandatory HCM confirmation at approval** — the HCM is the source of truth; no request is approved without live HCM confirmation.
- **Fail closed** — if HCM is unreachable or returns an unexpected error, the request stays `PENDING` (no double-deduction risk).
- **Available balance = total balance − (PENDING + APPROVED days)** — in-flight requests soft-lock the balance immediately.
- **Optimistic concurrency** on the `balances` table via a `version` column prevents lost updates under concurrent writes.

---

## Architecture

```
src/
├── app.module.js                    # Root module; TypeORM config
├── main.js                          # Bootstrap
│
├── balances/                        # Shadow balance management
│   ├── balances.module.js
│   ├── balances.controller.js       # GET /balances/:employeeId/:locationId
│   ├── balances.service.js          # Staleness check, upsert, deduction
│   └── balance.entity.js            # SQLite entity (version, lastSyncedAt)
│
├── time-off-requests/               # Request lifecycle
│   ├── time-off-requests.module.js
│   ├── time-off-requests.controller.js
│   ├── time-off-requests.service.js # State machine, approval flow
│   └── time-off-request.entity.js
│
├── hcm/                             # Single HCM integration boundary
│   ├── hcm.module.js
│   └── hcm.service.js               # getBalance(), submitDeduction()
│
├── sync/                            # Batch + single-record sync
│   ├── sync.module.js
│   ├── sync.controller.js           # POST /sync/batch, POST /sync/refresh/:emp/:loc
│   └── sync.service.js
│
└── common/filters/
    └── http-exception.filter.js     # Normalizes all errors → { error, message, timestamp, path }

mock-hcm/
└── main.js                          # Standalone Express mock HCM server (used by tests)

test/
├── unit/                            # Pure logic tests (mocked deps)
├── integration/                     # Real SQLite + mock HCM HTTP server
└── e2e/                             # Full HTTP round-trip tests
```

**Request lifecycle state machine:**

```
            submit
   ─────────────────► PENDING ──── approve ──► APPROVED
                         │
                         ├────── reject  ──► REJECTED
                         │
                         └────── cancel  ──► CANCELLED
```

All three terminal states (`APPROVED`, `REJECTED`, `CANCELLED`) have no outgoing transitions. Invalid transitions return `400 INVALID_REQUEST_STATE`.

---

## Prerequisites

- **Node.js** v18 or higher
- **npm** v8 or higher

No database installation needed — SQLite is embedded via `better-sqlite3`.

---

## Setup & Running

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env` or set variables directly (defaults are shown):

```bash
cp .env .env.local
# Edit as needed
```

Default `.env`:

```env
PORT=3000
HCM_BASE_URL=http://localhost:4000
HCM_TIMEOUT_MS=5000
BALANCE_STALE_THRESHOLD_MINUTES=15
DB_PATH=./time-off.db
```

### 3. Start the mock HCM server (required for real runs)

The mock HCM simulates an external HCM system with pre-seeded balances.

```bash
npm run start:mock
# Starts on http://localhost:4000
```

### 4. Start the microservice

```bash
npm start
# Starts on http://localhost:3000
```

Or with auto-reload during development:

```bash
npm run start:dev
```

---

## API Reference

All error responses follow the envelope:
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "timestamp": "2026-04-28T10:30:00Z",
  "path": "/time-off-requests/42/approve"
}
```

---

### Balance Endpoints

#### `GET /balances/:employeeId/:locationId`

Returns the current balance. Always triggers a real-time HCM refresh if the local record is missing or stale (> `BALANCE_STALE_THRESHOLD_MINUTES` old).

**Response 200:**
```json
{
  "employeeId": "emp_001",
  "locationId": "loc_us_pto",
  "balance": 10,
  "availableBalance": 7,
  "lastSyncedAt": "2026-04-28T10:30:00Z"
}
```

`availableBalance` = `balance` minus days tied up in `PENDING` or `APPROVED` requests.

**Response 503** — HCM unreachable and no local record exists.

---

### Time-Off Request Endpoints

#### `POST /time-off-requests`

Submit a new time-off request. Performs a local balance pre-check only — no HCM call at submission time.

**Request body:**
```json
{
  "employeeId": "emp_001",
  "locationId": "loc_us_pto",
  "startDate": "2026-06-01",
  "endDate": "2026-06-05",
  "days": 5,
  "reason": "Summer vacation"
}
```

**Response 201:**
```json
{
  "id": 42,
  "status": "PENDING",
  "message": "Request submitted. Pending manager approval."
}
```

**Error responses:**

| Status | Error code | Cause |
|---|---|---|
| 400 | `INVALID_DAYS` | `days` is zero or negative |
| 400 | `INVALID_DATE_RANGE` | `startDate` is after `endDate` |
| 422 | `INSUFFICIENT_BALANCE` | Available balance is less than requested days |

---

#### `GET /time-off-requests/:id`

Returns a single request by ID.

**Response 404** — `REQUEST_NOT_FOUND`

---

#### `GET /time-off-requests?employeeId=emp_001&locationId=loc_us_pto`

Lists all requests for an employee. `locationId` is optional.

---

#### `PATCH /time-off-requests/:id/approve`

Manager approves a request.

**Flow:**
1. Re-syncs balance from HCM (catches out-of-band changes).
2. Rechecks available balance against the HCM-fresh figure.
3. If still sufficient — submits deduction to HCM, marks `APPROVED`, deducts local shadow balance.
4. If HCM balance dropped — auto-transitions to `REJECTED`, returns `409`.
5. If HCM is unreachable — request stays `PENDING` (retryable by manager), returns `503`.

**Response 200:**
```json
{ "id": 42, "status": "APPROVED", "hcmConfirmed": true }
```

| Status | Error code | Cause |
|---|---|---|
| 400 | `INVALID_REQUEST_STATE` | Request is not in `PENDING` state |
| 409 | `HCM_BALANCE_INSUFFICIENT` | HCM balance no longer sufficient after re-sync |
| 503 | `HCM_UNAVAILABLE` | HCM timed out or returned 5xx |

---

#### `PATCH /time-off-requests/:id/reject`

Manager rejects a request. A `reason` is required.

**Request body:**
```json
{ "reason": "Team is fully booked this week." }
```

**Response 200:**
```json
{ "id": 42, "status": "REJECTED" }
```

| Status | Error code | Cause |
|---|---|---|
| 400 | `MISSING_REJECTION_REASON` | `reason` field is absent or blank |
| 400 | `INVALID_REQUEST_STATE` | Request is not in `PENDING` state |

---

#### `PATCH /time-off-requests/:id/cancel`

Employee cancels a pending request. Balance is automatically restored — no explicit credit needed because `availableBalance` is always computed live by excluding non-`PENDING`/`APPROVED` rows.

**Response 200:**
```json
{ "id": 42, "status": "CANCELLED" }
```

---

### Sync Endpoints

#### `POST /sync/batch`

Ingests a full corpus of HCM balances. Each entry is upserted by `(employeeId, locationId)`. Row-level errors do not abort the rest.

**Request body:**
```json
{
  "balances": [
    { "employeeId": "emp_001", "locationId": "loc_us_pto", "balance": 15 },
    { "employeeId": "emp_002", "locationId": "loc_us_pto", "balance": 10 }
  ]
}
```

**Response 200:**
```json
{
  "processed": 2,
  "upserted": 2,
  "errors": []
}
```

---

#### `POST /sync/refresh/:employeeId/:locationId`

Forces a real-time balance refresh for one employee/location from HCM.

**Response 200:**
```json
{
  "employeeId": "emp_001",
  "locationId": "loc_us_pto",
  "balance": 18,
  "lastSyncedAt": "2026-04-28T12:00:00Z",
  "message": "Balance refreshed from HCM."
}
```

---

## Running Tests

The test suite has three layers, all runnable independently.

```bash
# Unit tests only (fast, no I/O)
npm test

# Integration tests (real SQLite in-memory + mock HCM HTTP server)
npm run test:integration

# End-to-end tests (full HTTP round-trips through NestJS)
npm run test:e2e

# All layers
npm run test:all

# All layers + coverage report
npm run test:coverage
```

**Coverage summary (last run):**

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| All files | 94.75% | 81.18% | 97.43% | 95.12% |
| balances.service.js | 98% | 95.45% | 100% | 100% |
| time-off-requests.service.js | 100% | 92.59% | 100% | 100% |
| hcm.service.js | 91.3% | 64.28% | 100% | 91.3% |
| sync.service.js | 81.25% | 77.27% | 100% | 81.25% |

**Total: 86 tests passing across 4 test suites.**

### What the mock HCM server provides

The test suite spins up a real Express-based mock HCM server (not Jest module mocks) so timeout handling, malformed responses, and network errors can be tested with full HTTP fidelity:

| Admin endpoint | Purpose |
|---|---|
| `POST /hcm/admin/set-balance` | Simulate out-of-band changes (anniversary bonus, year-start reset) |
| `POST /hcm/admin/set-error-mode` | Force `timeout`, `server_error`, or `insufficient` responses |
| `POST /hcm/admin/reset` | Restore seed balances between tests |
| `GET /hcm/admin/state` | Inspect current mock state for debugging |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the NestJS service listens on |
| `HCM_BASE_URL` | `http://localhost:4000` | Base URL of the HCM system |
| `HCM_TIMEOUT_MS` | `5000` | Axios timeout for HCM calls (ms) |
| `BALANCE_STALE_THRESHOLD_MINUTES` | `15` | Age after which a local balance triggers an HCM refresh |
| `DB_PATH` | `./time-off.db` | SQLite database file path (use `:memory:` in tests) |

---

## Design Decisions

### Why optimistic check at submit + HCM confirmation at approve?

Submission is an employee-facing, latency-sensitive action. Adding a synchronous HCM call to every submission would make the service's availability dependent on HCM's availability — a poor trade-off for a routine daily operation. The local shadow balance acts as a fast pre-filter. The HCM is called at approval time, which is a manager action and can tolerate slightly more latency.

### Why keep requests `PENDING` (not `REJECTED`) on HCM timeout?

If the service auto-rejected on timeout and HCM had actually processed the request, the employee would have lost days with no way to recover gracefully. Leaving the request `PENDING` lets the manager retry when HCM recovers. This avoids the double-deduction risk that would come from retrying blindly.

### Why a real mock HCM server instead of Jest module mocks?

Jest module mocks bypass the actual axios client code. A real HTTP server lets the test suite simulate true network timeouts, `ECONNREFUSED`, and stateful balance changes between calls — all of which are explicitly required by the spec and impossible to reproduce faithfully with in-process mocks.

### Why `availableBalance` is never stored?

Storing a derived value creates a second source of truth. By computing `availableBalance = balance − SUM(PENDING + APPROVED days)` live on every read, cancellations automatically "free" balance without needing any explicit credit operation.

### Why per-row error isolation in batch sync?

A reconciliation workload should be maximally resilient. A single bad row (e.g. a negative balance from a data issue) should not abort the entire batch and leave thousands of employees with stale shadow balances. Each row is its own transaction.