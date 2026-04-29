# Technical Requirements Document (TRD)
## Time-Off Microservice — ExampleHR Platform

**Author:** Jaweria Amir    
**Version:** 1.0  
**Status:** Final  
**Date:** April 29, 2026  
**Stack:** NestJS · SQLite · JavaScript

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [System Context](#3-system-context)
4. [Key Engineering Challenges](#4-key-engineering-challenges)
5. [Proposed Architecture](#5-proposed-architecture)
6. [Data Model](#6-data-model)
7. [API Contract](#7-api-contract)
8. [HCM Integration Strategy](#8-hcm-integration-strategy)
9. [Balance Integrity & Concurrency](#9-balance-integrity--concurrency)
10. [Error Handling & Defensive Design](#10-error-handling--defensive-design)
11. [Design Decisions & Alternatives Considered](#11-design-decisions--alternatives-considered)
12. [Testing Strategy](#12-testing-strategy)
13. [Future Considerations](#13-future-considerations)

---

## 1. Overview

ExampleHR provides employees with a self-service interface for managing time-off requests. The underlying Human Capital Management (HCM) system, analogous to Workday or SAP, acts as the **source of truth** for all leave balance data. ExampleHR is not the only system that interacts with the HCM; external events such as work anniversaries, yearly resets, or payroll adjustments can modify balances at any time without ExampleHR's knowledge.

This document specifies the design of the **Time-Off Microservice**: the backend component responsible for managing time-off request lifecycles, maintaining a locally synchronized copy of HCM balances, and ensuring balance integrity across two loosely-coupled systems.

The core tension this service must resolve is:

> **Speed vs. Safety.** Employees want instant feedback. The HCM is the authority. These two requirements conflict, and the architecture must reconcile them without sacrificing either user experience or data correctness.

---

## 2. Goals & Non-Goals

### Goals

- Expose REST endpoints for creating, viewing, approving, rejecting, and cancelling time-off requests.
- Maintain a local "shadow" copy of HCM balances, kept synchronized via real-time calls and batch ingestion.
- Provide instant feedback to employees using the local balance, while confirming against HCM before finalizing any approval.
- Handle HCM unavailability gracefully — never approve a request when balance confirmation cannot be obtained.
- Support a batch ingestion endpoint through which the HCM can push a full corpus of balance data.
- Guard against race conditions in concurrent request submissions.
- Be fully testable with a mock HCM server that simulates real-world HCM behavior.

### Non-Goals

- This service does not implement authentication or authorization beyond basic role identification (employee vs. manager). Auth is assumed to be handled by an API gateway upstream.
- This service does not manage leave policy rules (accrual logic, carry-over caps). Those remain in the HCM.
- This service does not support real-time push notifications to clients (e.g., WebSockets). That is a separate concern.
- Multi-tenancy and organization-level isolation are out of scope for this iteration.

---

## 3. System Context

```
┌────────────────────────────────────────────────────────┐
│                    ExampleHR Platform                  │
│                                                        │
│   ┌──────────────┐        ┌────────────────────────┐  │
│   │   Frontend   │◄──────►│  Time-Off Microservice │  │
│   │  (Employee / │        │                        │  │
│   │   Manager)   │        │  - Request lifecycle   │  │
│   └──────────────┘        │  - Shadow balances     │  │
│                           │  - Sync logic          │  │
│                           └───────────┬────────────┘  │
└───────────────────────────────────────┼────────────────┘
                                        │
                          REST calls (real-time + batch)
                                        │
                              ┌─────────▼──────────┐
                              │    HCM System      │
                              │  (Source of Truth) │
                              │                    │
                              │  - Real-time API   │
                              │  - Batch endpoint  │
                              └────────────────────┘
```

**Balance flow summary:**

1. HCM holds the authoritative balance for every `(employeeId, locationId)` pair.
2. The microservice keeps a local shadow copy in SQLite, refreshed on read and via batch sync.
3. When a request is submitted, the local balance is checked immediately (for UX feedback).
4. When a request is approved, the HCM is contacted to confirm and deduct the balance.
5. Batch sync from HCM upserts all local balances to catch out-of-band changes (anniversaries, resets).

---

## 4. Key Engineering Challenges

### 4.1 Optimistic vs. Pessimistic Balance Validation

**The problem:** When an employee requests 5 days off, should the service immediately call HCM to verify the balance (safe but slow), or check the local copy first and then confirm with HCM at approval time (fast but carries a window of risk)?

This is the primary UX vs. safety trade-off in the entire system.

**Why pessimistic-only is problematic:** A synchronous HCM call on every request submission adds latency to the critical user path. If HCM is slow or temporarily unavailable, request submissions would fail entirely — a poor experience for something as routine as submitting a leave request.

**Why optimistic-only is dangerous:** If the local shadow balance is stale (e.g., HCM already deducted days due to an anniversary correction), the local check would pass a request that HCM would later reject, creating an inconsistent state.

**Chosen approach:** Optimistic local validation at submission time, with mandatory HCM confirmation at approval time. The local shadow balance acts as a fast pre-filter. The HCM is the final authority.

---

### 4.2 External HCM Balance Changes

**The problem:** The HCM can modify balances at any time, independently of ExampleHR. Common triggers include:

- **Year-start resets:** All balances are refreshed to their annual entitlement.
- **Work anniversary bonuses:** An employee receives additional days.
- **Payroll adjustments:** HR manually corrects a balance.
- **Other system interactions:** Third-party integrations touching the same HCM.

This means the local shadow balance can silently become incorrect between any two operations.

**Mitigations implemented:**

1. **`lastSyncedAt` timestamp** on every balance row: allows the system to detect staleness and decide whether to refresh before using the value.
2. **Forced refresh on balance reads:** when an employee views their balance, a real-time HCM call is made if the local record is missing or older than `BALANCE_STALE_THRESHOLD_MINUTES` (default: 15 minutes).
3. **Batch sync ingestion:** HCM can push the full corpus of balances at any time; each entry is upserted independently and acts as a reconciliation sweep.
4. **Pre-approval refresh:** before a manager approves a request, the local balance is re-synced from HCM to catch any changes that happened after submission.

---

### 4.3 Unreliable HCM Error Responses

**The problem:** The specification explicitly notes that HCM may not always return errors reliably. A timeout, a 500 response, or a malformed error payload must all be handled safely. Trusting HCM to catch every invalid request is not sufficient.

**Chosen approach:** Fail closed. The service applies local balance validation as a defensive layer regardless of HCM availability. If HCM cannot be reached or returns an ambiguous response, the in-flight operation is rejected and the failure is logged. An uncertain state is treated as an unsafe state.

Specifically:

- Local balance check runs first at submission time. If it fails locally, the request is rejected immediately without contacting HCM.
- At approval time, if HCM is unreachable or returns 5xx, the request stays **`PENDING`** — it is not auto-rejected. This is deliberate: auto-rejecting on a timeout would permanently close a request that HCM may have already processed, creating data loss. The manager retries when HCM recovers.
- If HCM returns an explicit insufficient-balance error (422/400), the request is auto-transitioned to `REJECTED` and the employee is notified.

---

### 4.4 Two Integration Patterns: Real-Time vs. Batch

**The problem:** HCM exposes two distinct integration mechanisms:

- **Real-time API:** Fetch or update a single `(employeeId, locationId)` balance. Low latency. Used for on-demand lookups and individual request approvals.
- **Batch endpoint:** Receive the full corpus of all balances in one payload. Used for periodic reconciliation, year-start resets, and anniversary updates.

**Chosen approach:** `HcmService` handles real-time calls (`getBalance`, `submitDeduction`). Batch ingestion is handled by `SyncService`, which calls `BalancesService.upsertFromHcm()` for each entry independently. This separation keeps concerns clean and allows batch errors to be isolated per-row without affecting real-time flows.

---

### 4.5 Race Conditions in Concurrent Requests

**The problem:** If two requests for the same employee and location are submitted simultaneously, both may pass the local balance check before either has been persisted.

```
Employee has 5 days.
Request A: 3 days → reads available (5) → passes check
Request B: 3 days → reads available (5) → passes check
Both submitted. Combined: 6 days. Overbooking.
```

**Chosen approach — two-layer defense:**

1. **Available balance formula:** The service always computes:
   ```
   availableBalance = currentBalance - SUM(days WHERE status IN ('PENDING', 'APPROVED'))
   ```
   In-flight requests soft-lock the balance immediately upon insertion, so any concurrent second read will see a reduced available balance.

2. **Optimistic concurrency control via `version` column:** Every write to the `balances` table includes the current version in the `WHERE` clause and increments it. If two concurrent writes race, only the first matches and the second gets `affected = 0`, triggering a `ConflictException`.

---

## 5. Proposed Architecture

### Module Structure

```
src/
├── app.module.js                    # Root module; TypeORM config reads DB_PATH from env
├── main.js                          # Bootstrap; registers global exception filter
│
├── balances/                        # Shadow balance management
│   ├── balances.module.js
│   ├── balances.controller.js       # GET /balances/:employeeId/:locationId
│   ├── balances.service.js          # Staleness check, upsert, deduction, available balance
│   └── balance.entity.js            # SQLite entity (version, lastSyncedAt, unique constraint)
│
├── time-off-requests/               # Core request lifecycle
│   ├── time-off-requests.module.js
│   ├── time-off-requests.controller.js
│   ├── time-off-requests.service.js # State machine, approval flow, submit/reject/cancel
│   └── time-off-request.entity.js   # SQLite entity (status, hcmConfirmed, indices)
│
├── hcm/                             # Single HCM integration boundary
│   ├── hcm.module.js
│   └── hcm.service.js               # getBalance(), submitDeduction(); centralised error handler
│
├── sync/                            # Batch + single-record sync
│   ├── sync.module.js
│   ├── sync.controller.js           # POST /sync/batch, POST /sync/refresh/:emp/:loc
│   └── sync.service.js              # Per-row upsert with isolated error collection
│
└── common/
    └── filters/
        └── http-exception.filter.js # Global filter; normalises all errors to { error, message, timestamp, path }

mock-hcm/
└── main.js                          # Standalone Express mock HCM server (tests only)

test/
├── unit/                            # Pure logic tests — all deps mocked
│   ├── balances.service.test.js
│   └── time-off-requests.service.test.js
├── integration/                     # Real SQLite in-memory + real mock HCM HTTP server
│   └── requests-flow.test.js
└── e2e/                             # Full HTTP round-trips through NestJS
    └── app.e2e.test.js
```

### Request Lifecycle State Machine

```
                    ┌──────────┐
        submit      │          │
   ────────────────►│ PENDING  │
                    │          │
                    └────┬─────┘
                         │
             ┌───────────┼───────────┐
             │           │           │
         approve       reject      cancel
             │           │           │
             ▼           ▼           ▼
        ┌─────────┐ ┌──────────┐ ┌───────────┐
        │APPROVED │ │ REJECTED │ │ CANCELLED │
        └─────────┘ └──────────┘ └───────────┘
```

Valid transitions:
- `PENDING → APPROVED` (manager approves; HCM confirms balance and deduction succeeds)
- `PENDING → REJECTED` (manager rejects with reason, or HCM returns insufficient balance at approval time)
- `PENDING → CANCELLED` (employee cancels before a decision is made)
- Terminal states (`APPROVED`, `REJECTED`, `CANCELLED`) have no outgoing transitions.

---

## 6. Data Model

### `balances` Table

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment primary key |
| `employeeId` | VARCHAR | Employee identifier from HCM |
| `locationId` | VARCHAR | Location/leave-type identifier |
| `balance` | DECIMAL(10,2) | Current total balance in days (stored as text by SQLite; always coerced with `parseFloat`) |
| `version` | INTEGER | Optimistic concurrency control counter; incremented on every write |
| `lastSyncedAt` | DATETIME | Timestamp of last HCM synchronization; used for staleness detection |
| `createdAt` | DATETIME | Record creation time (auto-managed by TypeORM) |
| `updatedAt` | DATETIME | Record last update time (auto-managed by TypeORM) |

**Unique constraint:** `(employeeId, locationId)` — each employee has at most one balance record per location.

**Derived field (never stored):** `availableBalance = balance - SUM(days of PENDING and APPROVED requests)`

**SQLite decimal note:** SQLite stores `DECIMAL` columns as text strings. TypeORM returns them without numeric coercion. All balance arithmetic uses `parseFloat()` with an `isNaN` guard.

---

### `time_off_requests` Table

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment primary key |
| `employeeId` | VARCHAR | The requesting employee |
| `locationId` | VARCHAR | Location/leave-type for this request |
| `startDate` | VARCHAR | ISO date string, e.g. `2026-06-01` |
| `endDate` | VARCHAR | ISO date string |
| `days` | INTEGER | Number of days requested (must be > 0) |
| `status` | VARCHAR | `PENDING`, `APPROVED`, `REJECTED`, or `CANCELLED` |
| `reason` | TEXT | Optional employee-provided reason |
| `rejectionReason` | TEXT | Populated when status transitions to `REJECTED` |
| `hcmConfirmed` | BOOLEAN | `true` only after HCM has acknowledged and processed the deduction |
| `createdAt` | DATETIME | Submission timestamp |
| `updatedAt` | DATETIME | Last status change timestamp |

**Indices:**
- `(employeeId)` — for listing requests by employee.
- `(employeeId, locationId, status)` — for the available balance `SUM` query.

---

## 7. API Contract

All error responses share a consistent envelope produced by the global exception filter:

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

Returns the current balance for an employee at a location. Triggers a real-time HCM refresh when the local record is missing or older than `BALANCE_STALE_THRESHOLD_MINUTES`.

**Response `200 OK`:**
```json
{
  "employeeId": "emp_001",
  "locationId": "loc_us_pto",
  "balance": 10,
  "availableBalance": 7,
  "lastSyncedAt": "2026-04-28T10:30:00Z"
}
```

> `availableBalance` = `balance` minus the sum of days in all `PENDING` and `APPROVED` requests for this employee/location. It is computed live on every read and never stored.

**Response `503 SERVICE_UNAVAILABLE`** — HCM is unreachable and no local record exists.

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
  "reason": "Family vacation"
}
```

**Response `201 Created`:**
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

Retrieve a single request by ID.

**Response `404`** — `REQUEST_NOT_FOUND`

---

#### `GET /time-off-requests?employeeId=emp_001&locationId=loc_us_pto`

List all requests for an employee, ordered by `createdAt DESC`. `locationId` is optional.

---

#### `PATCH /time-off-requests/:id/approve`

Manager approves a pending request.

**Approval flow:**
1. Validate `PENDING → APPROVED` transition.
2. Re-fetch balance from HCM and upsert into local shadow.
3. Recompute available balance from the fresh HCM figure, excluding this request from the reserved sum.
4. If available balance is now insufficient → auto-transition to `REJECTED`, return `409`.
5. Submit deduction to HCM (`POST /hcm/deduct`).
6. On HCM success → deduct local shadow balance, mark request `APPROVED`, set `hcmConfirmed: true`.
7. On HCM timeout or 5xx → exception propagates, request **stays `PENDING`** (retryable by manager), return `503`.

**Why PENDING and not REJECTED on HCM timeout:** Auto-rejecting on a timeout risks permanently closing a request that HCM may have already processed. Leaving it `PENDING` lets the manager retry when HCM recovers, eliminating the double-deduction risk of a blind retry.

**Response `200 OK`:**
```json
{
  "id": 42,
  "status": "APPROVED",
  "hcmConfirmed": true
}
```

| Status | Error code | Cause |
|---|---|---|
| 400 | `INVALID_REQUEST_STATE` | Request is not in `PENDING` state |
| 409 | `HCM_BALANCE_INSUFFICIENT` | HCM balance insufficient after re-sync; request auto-rejected |
| 503 | `HCM_UNAVAILABLE` | HCM timed out or returned 5xx; request stays PENDING |

---

#### `PATCH /time-off-requests/:id/reject`

Manager rejects a pending request. A non-empty `reason` is required.

**Request body:**
```json
{ "reason": "Overlaps with team deadline." }
```

**Response `200 OK`:**
```json
{ "id": 42, "status": "REJECTED" }
```

| Status | Error code | Cause |
|---|---|---|
| 400 | `MISSING_REJECTION_REASON` | `reason` field is absent or blank |
| 400 | `INVALID_REQUEST_STATE` | Request is not in `PENDING` state |

---

#### `PATCH /time-off-requests/:id/cancel`

Employee cancels a pending request. No explicit balance credit is needed — `availableBalance` is derived live by summing only `PENDING` and `APPROVED` rows. Moving to `CANCELLED` removes this request from that sum automatically.

**Response `200 OK`:**
```json
{ "id": 42, "status": "CANCELLED" }
```

| Status | Error code | Cause |
|---|---|---|
| 400 | `INVALID_REQUEST_STATE` | Request is not in `PENDING` state |

---

### Sync Endpoints

#### `POST /sync/batch`

Ingests a full corpus of HCM balances. Used for year-start resets, anniversary bonuses, or periodic reconciliation. Each entry is upserted independently — row-level errors do not abort the rest.

**Request body:**
```json
{
  "balances": [
    { "employeeId": "emp_001", "locationId": "loc_us_pto", "balance": 15 },
    { "employeeId": "emp_002", "locationId": "loc_us_pto", "balance": 10 }
  ]
}
```

**Response `200 OK`:**
```json
{
  "processed": 2,
  "upserted": 2,
  "errors": []
}
```

| Status | Error code | Cause |
|---|---|---|
| 400 | `INVALID_PAYLOAD` | `balances` array is missing or empty |

---

#### `POST /sync/refresh/:employeeId/:locationId`

Forces a real-time balance refresh for one `(employeeId, locationId)` pair from HCM. Useful after a known out-of-band HCM change (e.g. an anniversary bonus).

**Response `200 OK`:**
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

## 8. HCM Integration Strategy

### HcmService Interface

`HcmService` is the **single integration boundary** between this microservice and the HCM. All HCM HTTP calls go through this class. This makes it trivial to swap in a test double — tests inject a mock HcmService instance rather than needing to intercept HTTP.

```javascript
class HcmService {
  // Fetch current balance for one (employeeId, locationId)
  // Called during: balance reads (stale check), approve (pre-approval re-sync)
  async getBalance(employeeId, locationId) { ... }

  // Submit a balance deduction to HCM
  // Called only after the re-sync confirms sufficient balance (approve flow)
  async submitDeduction(employeeId, locationId, days) { ... }
}
```

Batch ingestion does **not** go through `HcmService`. It is handled by `SyncService`, which calls `BalancesService.upsertFromHcm()` directly for each entry. This keeps the HCM integration boundary focused on real-time operations only.

---

### Real-Time Approval Flow

```
1. Re-fetch balance from HCM              → upsert into local shadow
2. Recompute available (excluding this request from reserved sum)
3. If available < requested days          → auto-reject, return 409
4. POST /hcm/deduct                       → submit deduction to HCM
5. On HCM 2xx                            → deduct local shadow, mark APPROVED
6. On HCM timeout / 5xx                  → throw, request stays PENDING, return 503
```

No automatic retry is attempted for step 6. A retry after a network timeout could trigger a double deduction if HCM processed the first request but the response was lost. The manager re-attempts manually after HCM recovers.

---

### Batch Sync Flow

```
1. Receive array of { employeeId, locationId, balance }
2. Validate each entry (employeeId, locationId required; balance must be >= 0)
3. For each valid entry:
   a. UPSERT into balances table (insert if new, update if exists)
   b. Set lastSyncedAt = NOW(), increment version
4. Collect per-row errors without aborting the rest
5. Return { processed, upserted, errors[] }
```

---

### Timeout & Retry Policy

| Scenario | Behavior |
|---|---|
| HCM real-time call times out (ECONNABORTED) | Throw `HCM_UNAVAILABLE` (503); request stays PENDING |
| HCM unreachable (ECONNREFUSED) | Throw `HCM_UNAVAILABLE` (503); request stays PENDING |
| HCM returns 5xx | Throw `HCM_UNAVAILABLE` (503); request stays PENDING |
| HCM returns 422 or 400 (balance error) | Throw `HCM_BALANCE_INSUFFICIENT`; request auto-rejected (409) |
| HCM returns 2xx | Proceed; update local state |

Retries are never attempted automatically. An ambiguous HCM state must not result in a double deduction.

---

## 9. Balance Integrity & Concurrency

### Available Balance Formula

At any point in time, the available balance is computed as:

```
availableBalance = balance.currentBalance
                 - SUM(r.days
                       WHERE r.employeeId = :employeeId
                         AND r.locationId = :locationId
                         AND r.status IN ('PENDING', 'APPROVED'))
```

Including `APPROVED` rows prevents a race window where a second request could be submitted against balance that has been deducted from HCM but not yet reflected in the next batch sync. Including `PENDING` rows prevents overbooking from concurrent submissions. The result is always clamped to `Math.max(0, ...)`.

### Optimistic Concurrency Control

The `version` column on the `balances` table protects against lost updates:

```javascript
const result = await balanceRepo.update(
  { id: balance.id, version: balance.version },        // WHERE includes version
  { balance: newBalance, version: balance.version + 1 }
);

if (result.affected === 0) {
  throw new ConflictException('Balance was modified concurrently. Please retry.');
}
```

If two concurrent writes race on the same row, only the first matches the `version` predicate. The second gets `affected = 0` and throws `CONCURRENT_MODIFICATION`. The `version` is incremented on every write — both HCM upserts and local deductions.

### Staleness Threshold

`BALANCE_STALE_THRESHOLD_MINUTES` (default: `15`, configurable via environment variable) controls when a local balance record is considered stale. On every balance read, if `Date.now() - lastSyncedAt > threshold`, a real-time HCM refresh is triggered.

The threshold is read lazily at call time (not at module load time) so that integration tests can override it via `process.env` after the service has started, without needing to restart or re-require the module.

---

## 10. Error Handling & Defensive Design

### Principles

1. **Fail closed:** When in doubt, reject. Never approve a request without explicit HCM confirmation.
2. **Local guard first:** Apply local balance validation before any HCM call. This catches obvious errors cheaply and keeps HCM call volume low.
3. **Log everything:** All HCM interactions and errors are logged with `employeeId`, `locationId`, HTTP status, and timestamp at the point of failure — before the exception is re-wrapped — because that raw context is lost once it becomes a NestJS `HttpException`.
4. **No silent failures:** Every failed HCM call produces a structured `console.error` entry. The global exception filter logs every 4xx/5xx response with method, path, and message.

### Error Taxonomy

| Error Code | HTTP Status | When thrown |
|---|---|---|
| `INVALID_DAYS` | 400 | `days` ≤ 0 on submit |
| `INVALID_DATE_RANGE` | 400 | `startDate` > `endDate` on submit |
| `INVALID_REQUEST_STATE` | 400 | Invalid state transition attempted |
| `MISSING_REJECTION_REASON` | 400 | Rejection attempted with blank or absent reason |
| `INVALID_PAYLOAD` | 400 | Empty `balances` array on batch sync |
| `REQUEST_NOT_FOUND` | 404 | No request found for given ID |
| `INSUFFICIENT_BALANCE` | 422 | Local available balance check failed at submission time |
| `HCM_BALANCE_INSUFFICIENT` | 409 | HCM rejected deduction at approval time (422/400 from HCM) |
| `CONCURRENT_MODIFICATION` | 409 | Balance `version` mismatch on concurrent write |
| `HCM_UNAVAILABLE` | 503 | HCM timed out, unreachable, or returned 5xx |

### Global Exception Filter

`HttpExceptionFilter` is registered globally in `main.js`. It catches every thrown exception and normalises the response:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "timestamp": "2026-04-28T10:30:00Z",
  "path": "/time-off-requests/42/approve"
}
```

When the exception body is a plain string (e.g. NestJS internal errors), the string is used as `message` and the error code falls back to `INTERNAL_SERVER_ERROR`.

---

## 11. Design Decisions & Alternatives Considered

### Decision 1: Optimistic Local Check + Mandatory HCM Confirmation at Approval

**Chosen:** Check local shadow balance at submission (fast, no HCM call), then re-sync and confirm with HCM at approval time (authoritative, mandatory).

**Alternative A — Pessimistic (HCM on every submission):**
- Pro: Maximum accuracy at submission time.
- Con: Submission latency depends on HCM availability. If HCM is slow or down, employees cannot submit — a poor UX for a routine daily action.
- Con: Higher HCM API call volume; may hit rate limits.

**Alternative B — Fully optimistic (local only, no HCM at approval):**
- Pro: No HCM dependency at all after the initial sync.
- Con: Cannot detect out-of-band HCM changes. Risk of approving requests the HCM would reject. Violates the "source of truth" contract.

**Why chosen approach wins:** It respects HCM as the source of truth while keeping the employee-facing submission path fast. The approval step is a manager action (not real-time interactive), so the additional HCM call latency is acceptable there.

---

### Decision 2: Request stays PENDING (not auto-REJECTED) on HCM Timeout

**Chosen:** When HCM times out or returns 5xx during the approval deduction step, the request stays `PENDING`. A `503` is returned to the manager.

**Alternative — Auto-reject on any HCM failure:**
- Pro: Cleaner state — the request is always in a terminal state after the approval attempt.
- Con: If HCM processed the deduction but the response was lost in transit, the request is rejected while HCM has already deducted the days. The employee loses leave days with no recourse. This is data loss.

**Why chosen approach wins:** `PENDING` is the safe neutral state. The manager can inspect the situation and retry. This avoids the double-deduction risk (if HCM succeeded) and the data-loss risk (if we auto-reject). The spec explicitly calls for a no-retry policy for exactly this reason.

---

### Decision 3: SQLite Shadow Balance with `version` + `lastSyncedAt`

**Chosen:** A local `balances` table that mirrors HCM state, with version-based concurrency control and staleness tracking.

**Alternative A — No local copy, always call HCM:**
- Pro: Always accurate.
- Con: Complete dependency on HCM uptime. Any HCM degradation makes ExampleHR unusable even for reads.

**Alternative B — Local copy with TTL-based invalidation only (no `version`):**
- Pro: Simpler.
- Con: No protection against concurrent writes. Two simultaneous balance updates could silently overwrite each other.

**Why chosen approach wins:** The `version` column adds minimal complexity but provides meaningful safety against concurrency bugs. `lastSyncedAt` gives operators visibility into data freshness and drives the configurable staleness refresh.

---

### Decision 4: Per-Row Error Isolation in Batch Sync

**Chosen:** Each entry in a batch sync is upserted in its own try/catch. Failures are collected per-row and returned in the response. The batch as a whole never aborts.

**Alternative — Single transaction for the whole batch:**
- Pro: Either everything succeeds or nothing does.
- Con: One bad row (e.g. a negative balance from a data issue) rolls back thousands of valid updates, leaving all employees with stale shadow balances.

**Why chosen approach wins:** A reconciliation workload should maximise the number of records that reach a known-good state. Partial success is better than total rollback for this use case.

---

### Decision 5: State Machine for Request Lifecycle

**Chosen:** Explicit `status` column with a `VALID_TRANSITIONS` map enforced in the service layer.

**Alternative — Boolean flags (`isApproved`, `isRejected`, `isCancelled`):**
- Pro: Simpler schema.
- Con: Allows logically impossible states (e.g. `isApproved = true AND isRejected = true`). No single place to enforce transition rules.

**Why chosen approach wins:** A single `status` string with a transition table is self-documenting, extensible, and prevents illegal states. Adding a new status (e.g. `UNDER_REVIEW`) requires changing one map, not multiple boolean columns.

---

### Decision 6: Dedicated Mock HCM Server (Real HTTP)

**Chosen:** A standalone Express-based mock HCM server (`mock-hcm/main.js`) that runs as a real HTTP server during integration and E2E tests.

**Alternative A — In-process Jest module mocks:**
- Pro: No extra server to manage.
- Con: Mocks bypass the actual `axios` client code. True network timeouts (`ECONNABORTED`), `ECONNREFUSED`, and malformed response handling cannot be simulated accurately.

**Alternative B — Record/replay (e.g. `nock`):**
- Pro: Realistic HTTP without a live server.
- Con: Recorded responses go stale; hard to simulate stateful scenarios like a balance change between two sequential calls within one test.

**Why chosen approach wins:** A real HTTP server can simulate stateful HCM behavior (balance changes between calls), true axios timeout paths, and all documented error modes. Admin endpoints (`/hcm/admin/set-balance`, `/hcm/admin/set-error-mode`, `/hcm/admin/reset`) let each test set up exactly the HCM state it needs without leaking into adjacent tests.

---

## 12. Testing Strategy

Testing is treated as a primary deliverable. The test suite is structured in three layers, each serving a distinct purpose.

### Layer 1: Unit Tests

Each service is tested in isolation with all external dependencies manually mocked. No database. No HTTP.

**Covered in `test/unit/`:**
- `BalancesService` — balance calculation, staleness detection, upsert create vs. update path, version conflict detection, decimal coercion from SQLite strings.
- `TimeOffRequestsService` — all state transitions (valid and invalid), submission validation, approval flow (happy path, HCM insufficient, HCM unavailable), rejection reason validation, cancel logic.

**Tools:** Jest with manually constructed repository and service mocks (no `jest.mock()` — dependencies are injected via constructor).

**Result: 42 unit tests, all passing.**

---

### Layer 2: Integration Tests

Tests the interaction between all modules using a real SQLite in-memory database and a real mock HCM HTTP server on a random OS-assigned port.

**Key scenarios in `test/integration/requests-flow.test.js`:**
- Submit → available balance reduces → second request sees reduced balance.
- Submit → approve → HCM called → local balance deducted.
- Submit → HCM balance drops externally → approve → auto-rejected (409).
- Submit → approve → HCM times out → request stays PENDING (503).
- Submit → approve → HCM returns 500 → request stays PENDING (503).
- Invalid transition (REJECTED → APPROVED) → 400.
- Reject with reason → 200; reject without reason → 400.
- Cancel PENDING → balance freed; cancel CANCELLED → 400.
- Batch sync upserts new and existing; subsequent request sees updated balance.
- Batch sync isolates per-row errors.
- Sync refresh returns updated balance after out-of-band HCM change.

**Result: 19 integration tests, all passing.**

---

### Layer 3: End-to-End Tests

Full HTTP request/response tests against the running NestJS application. Exercises every endpoint and every documented error code.

**Key scenarios in `test/e2e/app.e2e.test.js`:**
- Full happy path: submit → approve → balance deducted.
- All submit validation errors (insufficient balance, zero days, invalid date range).
- Approval with external HCM balance changes (drop → 409; anniversary bonus → succeeds).
- HCM defensive behavior: server error → 503; timeout → 503; HCM down during balance read → 503.
- Reject flow (with reason → 200; without reason → 400).
- Cancel flow: balance restored after cancel.
- State machine enforcement: all invalid transitions blocked.
- Batch sync: summary response, updated balance visible, empty array → 400, row error isolation.
- Not found: GET and PATCH on non-existent IDs → 404.

**Result: 25 E2E tests, all passing.**

---

### Coverage Results

```
File                              | % Stmts | % Branch | % Funcs | % Lines
----------------------------------|---------|----------|---------|--------
All files                         |   94.75 |    81.18 |   97.43 |   95.12
balances.service.js               |   98.00 |    95.45 |  100.00 |  100.00
time-off-requests.service.js      |  100.00 |    92.59 |  100.00 |  100.00
hcm.service.js                    |   91.30 |    64.28 |  100.00 |   91.30
sync.service.js                   |   81.25 |    77.27 |  100.00 |   81.25
balances.controller.js            |  100.00 |   100.00 |  100.00 |  100.00
time-off-requests.controller.js   |   96.96 |   100.00 |   85.71 |   96.96
sync.controller.js                |  100.00 |   100.00 |  100.00 |  100.00
```

**Total: 86 tests across 4 test suites. All passing.**

---

### Mock HCM Server Details

The mock HCM server (`mock-hcm/main.js`) is a standalone Express application:

- Maintains an in-memory balance store initialized from seed data.
- Exposes `GET /hcm/balance/:employeeId/:locationId` — real-time balance lookup.
- Exposes `POST /hcm/deduct` — balance deduction; validates and mutates in-memory state.
- Exposes `POST /hcm/admin/set-balance` — simulate out-of-band changes (anniversary bonus, correction).
- Exposes `POST /hcm/admin/set-error-mode` — force `timeout`, `server_error`, `insufficient`, or `bad_json` per key or globally.
- Exposes `POST /hcm/admin/reset` — restore seed state between tests.
- Exposes `GET /hcm/admin/state` — inspect current in-memory state for debugging.

The server is started on a random OS-assigned port in `beforeAll` and torn down in `afterAll`. Every test calls `/hcm/admin/reset` in `beforeEach` for isolation.

---

## 13. Future Considerations

The following are explicitly out of scope for this iteration but worth noting for future planning:

- **Webhook from HCM:** Rather than relying on batch sync, HCM could push balance-change events via webhook. This would reduce the latency of out-of-band changes reaching the shadow copy.
- **Request approval workflows:** Multi-level approval chains (e.g. team lead → HR). Currently, any manager can approve any request.
- **Leave type validation:** Validating that the requested `locationId` is a leave type the employee is eligible for. Currently delegated to HCM error responses.
- **Calendar integration:** Calculating business days between `startDate` and `endDate` accounting for weekends and public holidays.
- **Audit log:** A separate `audit_log` table tracking every state transition, who triggered it, and when — useful for compliance and debugging.
- **Rate limiting on HCM calls:** A spike of simultaneous approvals could generate a burst of HCM deduction requests. A queue or rate limiter may be needed at scale.
- **Idempotency keys on deduction:** Adding an idempotency key to `POST /hcm/deduct` would allow safe retries without double-deduction risk, removing the current constraint that managers must retry manually.

---

*End of Technical Requirements Document*
