const {
  Injectable,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} = require('@nestjs/common');

/**
 * WHY no module-level constant for STALE_THRESHOLD_MINUTES:
 * Node caches modules at require() time. If the integration test sets
 * process.env.BALANCE_STALE_THRESHOLD_MINUTES = '0' AFTER this module
 * is first required, a module-level parseInt() would have already captured
 * the default '15'. Reading the env lazily inside _isStale() ensures the
 * test override always takes effect. (TRD §9 — Staleness Threshold)
 */

class BalancesService {
  constructor(balanceRepo, hcmService, requestRepo) {
    this.balanceRepo = balanceRepo;
    this.hcmService  = hcmService;
    this.requestRepo = requestRepo;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Return balance for (employeeId, locationId).
   *
   * Per TRD §4.2 and §7 (GET /balances/:employeeId/:locationId):
   * Always triggers a real-time HCM refresh when the local record is
   * missing or stale. availableBalance is derived live — never stored.
   */
  async getBalance(employeeId, locationId) {
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    const isStale = !balance || this._isStale(balance.lastSyncedAt);

    if (isStale) {
      const hcmData = await this.hcmService.getBalance(employeeId, locationId);
      balance = await this.upsertFromHcm(employeeId, locationId, hcmData.balance);
    }

    const rawBalance       = this._toNumber(balance.balance);
    const availableBalance = await this._computeAvailableBalance(
      employeeId, locationId, rawBalance
    );

    return {
      employeeId,
      locationId,
      balance:          rawBalance,
      availableBalance,
      lastSyncedAt:     balance.lastSyncedAt,
    };
  }

  /**
   * Upsert a balance record from HCM data.
   * Used by: getBalance (stale refresh), batch sync, pre-approval re-sync.
   *
   * WHY version increment on every write (TRD §9 — Optimistic Concurrency):
   * Lets concurrent-write checks detect whether a deduction raced an HCM
   * refresh. The WHERE clause includes version so only the writer that read
   * the current version wins; the other gets affected=0 and throws.
   */
  async upsertFromHcm(employeeId, locationId, newBalance) {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    const now = new Date();

    if (existing) {
      const result = await this.balanceRepo.update(
        { id: existing.id, version: existing.version },   // optimistic lock
        {
          balance:      newBalance,
          version:      existing.version + 1,
          lastSyncedAt: now,
        }
      );

      if (result.affected === 0) {
        throw new ConflictException({
          error:   'CONCURRENT_MODIFICATION',
          message: 'Balance was modified concurrently. Please retry.',
        });
      }

      return {
        ...existing,
        balance:      newBalance,
        version:      existing.version + 1,
        lastSyncedAt: now,
      };
    }

    // First time we have seen this (employeeId, locationId) pair.
    const created = this.balanceRepo.create({
      employeeId,
      locationId,
      balance:      newBalance,
      version:      1,
      lastSyncedAt: now,
    });
    return this.balanceRepo.save(created);
  }

  /**
   * Deduct days from the local shadow balance after HCM confirms the
   * deduction. Called only from the approve flow (TRD §8).
   *
   * WHY guard against negative (TRD §4.3 — Fail Closed):
   * HCM should catch insufficient balance, but we never rely on that
   * exclusively. Local guard runs regardless of HCM availability.
   */
  async deductBalance(employeeId, locationId, days) {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!balance) {
      throw new NotFoundException({
        error:   'BALANCE_NOT_FOUND',
        message: `No balance found for employee ${employeeId} at location ${locationId}.`,
      });
    }

    const current    = this._toNumber(balance.balance);
    const newBalance = current - days;

    if (newBalance < 0) {
      throw new UnprocessableEntityException({
        error:   'INSUFFICIENT_BALANCE',
        message: `Deducting ${days} day(s) would result in negative balance (current: ${current}).`,
      });
    }

    const result = await this.balanceRepo.update(
      { id: balance.id, version: balance.version },
      { balance: newBalance, version: balance.version + 1, lastSyncedAt: new Date() }
    );

    if (result.affected === 0) {
      throw new ConflictException({
        error:   'CONCURRENT_MODIFICATION',
        message: 'Balance was modified concurrently. Please retry.',
      });
    }
  }

  /**
   * Pre-submission check: is available balance >= requestedDays?
   * Returns { available, sufficient } for the caller to build an error message.
   *
   * WHY seed from HCM when no local record exists (TRD §4.1 + §4.3):
   * An employee with no shadow balance record has simply never been synced
   * to this service yet. Returning available=0 would silently block their
   * first-ever submission — wrong UX and wrong correctness. Instead we pull
   * from HCM once to seed the shadow, then proceed with the local check.
   * All subsequent calls hit the local cache as normal.
   *
   * This is safe because:
   *   1. We are only reading from HCM (no mutation).
   *   2. The seeded record is immediately used for the check — no stale window.
   *   3. If HCM itself is unavailable, the exception propagates and the
   *      submission fails closed (TRD §4.3).
   */
  async checkAvailableBalance(employeeId, locationId, requestedDays) {
    let local = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!local) {
      const hcmData = await this.hcmService.getBalance(employeeId, locationId);
      local = await this.upsertFromHcm(employeeId, locationId, hcmData.balance);
    }

    const rawBalance = this._toNumber(local.balance);
    const available  = await this._computeAvailableBalance(
      employeeId, locationId, rawBalance
    );

    return { available, sufficient: available >= requestedDays };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * availableBalance = rawBalance − SUM(days WHERE status IN PENDING, APPROVED)
   *
   * WHY include APPROVED (TRD §9 — Available Balance Formula):
   * Approved requests have been deducted from HCM but the next HCM batch
   * sync may not yet have arrived. Subtracting locally prevents the window
   * where a second request could be submitted against already-spent balance.
   *
   * WHY include PENDING:
   * In-flight requests soft-lock the balance immediately upon submission,
   * preventing overbooking even before a manager approves.
   */
  async _computeAvailableBalance(employeeId, locationId, rawBalance) {
    const row = await this.requestRepo
      .createQueryBuilder('r')
      .select('SUM(r.days)', 'total')
      .where('r.employeeId = :employeeId', { employeeId })
      .andWhere('r.locationId = :locationId', { locationId })
      .andWhere('r.status IN (:...statuses)', { statuses: ['PENDING', 'APPROVED'] })
      .getRawOne();

    const reserved = this._toNumber(row?.total);
    return Math.max(0, rawBalance - reserved);
  }

  /**
   * Returns true when the local balance record is older than the configured
   * staleness threshold, indicating a real-time HCM refresh is needed.
   *
   * WHY lazy env read (TRD §9 — Staleness Threshold):
   * Module-level constants are captured when Node first requires the file.
   * Integration tests set BALANCE_STALE_THRESHOLD_MINUTES=0 after startup.
   * Reading process.env here — at call time — ensures that override works.
   */
  _isStale(lastSyncedAt) {
    if (!lastSyncedAt) return true;
    const thresholdMinutes = parseInt(
      process.env.BALANCE_STALE_THRESHOLD_MINUTES || '15',
      10
    );
    const ageMs = Date.now() - new Date(lastSyncedAt).getTime();
    return ageMs > thresholdMinutes * 60 * 1000;
  }

  /**
   * Safe numeric coercion.
   *
   * WHY needed: SQLite stores DECIMAL columns as text strings; TypeORM
   * returns them as-is without coercion. SUM() on zero rows returns null.
   * parseFloat handles both cases; isNaN guard covers null/undefined/empty.
   */
  _toNumber(value) {
    const n = parseFloat(value);
    return isNaN(n) ? 0 : n;
  }
}

// NestJS 11: Injectable() mutates BalancesService in place and returns
// undefined. Export the ORIGINAL class — it now has the metadata attached.
Injectable()(BalancesService);
module.exports.BalancesService = BalancesService;