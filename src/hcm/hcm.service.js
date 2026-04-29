const {
  Injectable,
  UnprocessableEntityException,
  ServiceUnavailableException,
} = require('@nestjs/common');
const axios = require('axios');

const HCM_BASE_URL   = process.env.HCM_BASE_URL  || 'http://localhost:4000';
const HCM_TIMEOUT_MS = parseInt(process.env.HCM_TIMEOUT_MS || '5000', 10);

/*
 * HcmService — single integration boundary between this microservice and HCM.
 *
 * ALL HCM HTTP calls go through this class. This makes it trivial to swap
 * in a mock during tests (just provide a different HCmService instance).
 *
 * Three methods (per TRD §8):
 *   getBalance      — real-time lookup for one (employeeId, locationId)
 *   submitDeduction — deduct days at approval time
 *   (batch sync is handled by SyncService calling BalancesService directly)
 *
 * Error handling (per TRD §10):
 *   - 422 / 400  → HCM_BALANCE_INSUFFICIENT (reject the request)
 *   - timeout    → HCM_UNAVAILABLE           (fail closed)
 *   - 5xx / other→ HCM_UNAVAILABLE           (fail closed)
 */
class HcmService {

  /**
   * Fetch the current balance for one employee/location from HCM.
   * Called during: getBalance (stale check), approve (pre-approval re-sync).
   */
  async getBalance(employeeId, locationId) {
    try {
      const res = await axios.get(
        `${HCM_BASE_URL}/hcm/balance/${employeeId}/${locationId}`,
        { timeout: HCM_TIMEOUT_MS }
      );
      return res.data;
    } catch (err) {
      this._handleError(err, 'getBalance', { employeeId, locationId });
    }
  }

  /**
   * Submit a balance deduction to HCM.
   * Called only after the local re-sync shows sufficient balance (approve flow).
   *
   * WHY no automatic retry: a retry after a timeout could cause a double
   * deduction if HCM processed the first request but the response was lost.
   * The manager must retry manually (per TRD §8 Timeout & Retry Policy).
   */
  async submitDeduction(employeeId, locationId, days) {
    try {
      const res = await axios.post(
        `${HCM_BASE_URL}/hcm/deduct`,
        { employeeId, locationId, days },
        { timeout: HCM_TIMEOUT_MS }
      );
      return res.data;
    } catch (err) {
      this._handleError(err, 'submitDeduction', { employeeId, locationId, days });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Centralised error handler for all HCM calls.
   *
   * Logs the failure with full context, then throws the appropriate NestJS
   * exception so the global filter can return the right HTTP status.
   *
   * WHY log here (not just throw): the HTTP status and HCM response body are
   * only available at the axios error level. By the time the global filter
   * sees the exception it's already a NestJS HttpException — the raw HCM
   * detail would be lost without logging here.
   */
  _handleError(err, operation, context) {
    const timestamp = new Date().toISOString();
    const status    = err.response?.status;
    const data      = err.response?.data;

    console.error(
      `[HCM][${timestamp}] ${operation} failed`,
      JSON.stringify({ status, context, data, message: err.message })
    );

    // HCM explicitly rejected the request (bad dimensions or insufficient balance)
    if (status === 422 || status === 400) {
      throw new UnprocessableEntityException({
        error:   'HCM_BALANCE_INSUFFICIENT',
        message: data?.message || 'HCM rejected the deduction request.',
      });
    }

    // Timeout: axios sets code = 'ECONNABORTED'; no response object
    // Unreachable: ECONNREFUSED etc.; also no response object (status undefined)
    if (err.code === 'ECONNABORTED' || !status) {
      throw new ServiceUnavailableException({
        error:   'HCM_UNAVAILABLE',
        message: 'HCM is currently unreachable. Please retry later.',
      });
    }

    // Any other HTTP error (5xx, unexpected 4xx)
    throw new ServiceUnavailableException({
      error:   'HCM_UNAVAILABLE',
      message: `HCM returned an unexpected error (HTTP ${status}).`,
    });
  }
}

Injectable()(HcmService);          // mutates HcmService in place, return value is undefined
module.exports.HcmService = HcmService;  // export the original class