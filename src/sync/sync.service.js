const { Injectable } = require('@nestjs/common');

/*
 * SyncService
 *
 * Handles two sync patterns described in TRD §4.4:
 *
 *   1. Batch sync   — HCM pushes the full corpus; we upsert every row.
 *   2. Single refresh — force a real-time re-fetch for one (employeeId, locationId).
 *
 * WHY per-row error isolation in batch (not a single transaction):
 * The TRD explicitly says we should return a summary of processed / failed
 * entries. A single transaction would roll back everything if one row is bad,
 * which is worse than partial success for a reconciliation workload. Each row
 * is its own unit of work.
 */
class SyncService {
  /**
   * @param {import('../balances/balances.service').BalancesService} balancesService
   * @param {import('../hcm/hcm.service').HcmService} hcmService
   */
  constructor(balancesService, hcmService) {
    this.balancesService = balancesService;
    this.hcmService      = hcmService;
  }

  /**
   * Ingest a batch of balance records from HCM.
   *
   * Each entry is upserted independently. Failures on individual rows are
   * collected and returned in the response — they do NOT abort the rest.
   *
   * @param {Array<{ employeeId: string, locationId: string, balance: number }>} balances
   * @returns {{ processed: number, upserted: number, errors: Array }}
   */
  async processBatch(balances) {
    let upserted = 0;
    const errors = [];

    for (const entry of balances) {
      // Basic shape validation before hitting the DB
      const validationError = this._validateEntry(entry);
      if (validationError) {
        errors.push({ entry, error: validationError });
        continue;
      }

      try {
        await this.balancesService.upsertFromHcm(
          entry.employeeId,
          entry.locationId,
          entry.balance
        );
        upserted++;
      } catch (err) {
        // Log and collect; do not throw — isolate this row's failure
        console.error(
          `[SyncService] Failed to upsert balance for ` +
          `${entry.employeeId}/${entry.locationId}: ${err.message}`
        );
        errors.push({ entry, error: err.message });
      }
    }

    return {
      processed: balances.length,
      upserted,
      errors,
    };
  }

  /**
   * Force a real-time balance refresh for a single (employeeId, locationId).
   */
  async refreshOne(employeeId, locationId) {
    const hcmData = await this.hcmService.getBalance(employeeId, locationId);
    const balance = await this.balancesService.upsertFromHcm(
      employeeId,
      locationId,
      hcmData.balance
    );

    return {
      employeeId,
      locationId,
      balance:      parseFloat(balance.balance) || 0,
      lastSyncedAt: balance.lastSyncedAt,
      message:      'Balance refreshed from HCM.',
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate one batch entry. Returns an error string, or null if valid.
   *
   * WHY manual validation: class-validator requires TypeScript decorators.
   * Simple manual checks are clearer and sufficient for this shape.
   */
  _validateEntry(entry) {
    if (!entry.employeeId || typeof entry.employeeId !== 'string') {
      return 'employeeId is required and must be a string';
    }
    if (!entry.locationId || typeof entry.locationId !== 'string') {
      return 'locationId is required and must be a string';
    }
    if (entry.balance === undefined || entry.balance === null) {
      return 'balance is required';
    }
    if (typeof entry.balance !== 'number' || isNaN(entry.balance)) {
      return 'balance must be a number';
    }
    if (entry.balance < 0) {
      return 'balance must be >= 0';
    }
    return null;
  }
}

Injectable()(SyncService);
module.exports.SyncService = SyncService;