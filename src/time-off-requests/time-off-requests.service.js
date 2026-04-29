const {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  ConflictException,
} = require('@nestjs/common');

const VALID_TRANSITIONS = {
  PENDING:   ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED:  [],
  REJECTED:  [],
  CANCELLED: [],
};

class TimeOffRequestsService {
  constructor(requestRepo, balancesService, hcmService) {
    this.requestRepo     = requestRepo;
    this.balancesService = balancesService;
    this.hcmService      = hcmService;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async findById(id) {
    const req = await this.requestRepo.findOne({ where: { id } });
    if (!req) {
      throw new NotFoundException({
        error:   'REQUEST_NOT_FOUND',
        message: `Time-off request #${id} not found.`,
      });
    }
    return req;
  }

  async findByEmployee(employeeId, locationId) {
    const where = { employeeId };
    if (locationId) where.locationId = locationId;
    return this.requestRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Submit a new time-off request.
   *
   * Flow:
   *   1. Validate input (days > 0, startDate <= endDate).
   *   2. Local balance pre-check — fast, no HCM call.
   *   3. Insert with status PENDING.
   *
   * WHY no HCM call here: submission is employee-facing, must be fast.
   * HCM is authoritative only at approval time (TRD §4.1).
   */
  async submit({ employeeId, locationId, startDate, endDate, days, reason }) {
    if (!days || days <= 0) {
      throw new BadRequestException({
        error:   'INVALID_DAYS',
        message: 'days must be a positive integer.',
      });
    }
    if (startDate > endDate) {
      throw new BadRequestException({
        error:   'INVALID_DATE_RANGE',
        message: 'startDate must be on or before endDate.',
      });
    }

    const { available, sufficient } =
      await this.balancesService.checkAvailableBalance(employeeId, locationId, days);

    if (!sufficient) {
      throw new UnprocessableEntityException({
        error:   'INSUFFICIENT_BALANCE',
        message: `Available balance (${available} days) is less than requested (${days} days).`,
      });
    }

    const request = this.requestRepo.create({
      employeeId,
      locationId,
      startDate,
      endDate,
      days,
      reason:       reason || null,
      status:       'PENDING',
      hcmConfirmed: false,
    });

    const saved = await this.requestRepo.save(request);

    return {
      id:      saved.id,
      status:  saved.status,
      message: 'Request submitted. Pending manager approval.',
    };
  }

  /**
   * Manager approves a request.
   *
   * Flow (TRD §8):
   *   1. Validate PENDING → APPROVED transition.
   *   2. Re-sync balance from HCM (catches out-of-band changes).
   *   3. Recheck available balance — reject if no longer sufficient.
   *   4. Submit deduction to HCM.
   *   5. On success → APPROVED + deduct local shadow.
   *   6. On HCM error → exception propagates, request stays PENDING for retry.
   *
   * WHY no auto-retry on timeout: double-deduction risk (TRD §8).
   */
  async approve(id) {
    const request = await this.findById(id);
    this._assertTransition(request.status, 'APPROVED');

    const { employeeId, locationId, days } = request;

    // Step 2: force fresh HCM data into local shadow
    const hcmData = await this.hcmService.getBalance(employeeId, locationId);
    await this.balancesService.upsertFromHcm(employeeId, locationId, hcmData.balance);

    // Step 3: recheck — exclude this request from the reserved sum
    const rawBalance = this._toNumber(hcmData.balance);
    const available  = await this._computeAvailableExcluding(
      employeeId, locationId, rawBalance, id
    );

    if (available < days) {
      await this._updateStatus(request, 'REJECTED', {
        rejectionReason: `HCM balance (${rawBalance}) is no longer sufficient after re-sync.`,
      });
      throw new ConflictException({
        error:   'HCM_BALANCE_INSUFFICIENT',
        message: `HCM balance (${rawBalance} days available) is insufficient for ${days} days.`,
      });
    }

    // Step 4: submit deduction — throws on HCM error, request stays PENDING
    await this.hcmService.submitDeduction(employeeId, locationId, days);

    // Step 5: HCM confirmed — update local state
    await this.balancesService.deductBalance(employeeId, locationId, days);
    await this._updateStatus(request, 'APPROVED', { hcmConfirmed: true });

    return { id, status: 'APPROVED', hcmConfirmed: true };
  }

  /**
   * Manager rejects a request. Reason is required.
   */
  async reject(id, reason) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException({
        error:   'MISSING_REJECTION_REASON',
        message: 'A rejection reason is required.',
      });
    }
    const request = await this.findById(id);
    this._assertTransition(request.status, 'REJECTED');
    await this._updateStatus(request, 'REJECTED', { rejectionReason: reason.trim() });
    return { id, status: 'REJECTED' };
  }

  /**
   * Employee cancels a pending request.
   *
   * WHY no explicit balance credit: availableBalance subtracts only
   * PENDING + APPROVED rows. Moving to CANCELLED removes this request from
   * that sum automatically.
   */
  async cancel(id) {
    const request = await this.findById(id);
    this._assertTransition(request.status, 'CANCELLED');
    await this._updateStatus(request, 'CANCELLED');
    return { id, status: 'CANCELLED' };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _assertTransition(currentStatus, targetStatus) {
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new BadRequestException({
        error:   'INVALID_REQUEST_STATE',
        message: `Cannot transition from ${currentStatus} to ${targetStatus}.`,
      });
    }
  }

  async _updateStatus(request, newStatus, extra = {}) {
    Object.assign(request, { status: newStatus, ...extra });
    return this.requestRepo.save(request);
  }

  async _computeAvailableExcluding(employeeId, locationId, rawBalance, excludeId) {
    const row = await this.requestRepo
      .createQueryBuilder('r')
      .select('SUM(r.days)', 'total')
      .where('r.employeeId = :employeeId', { employeeId })
      .andWhere('r.locationId = :locationId', { locationId })
      .andWhere('r.status IN (:...statuses)', { statuses: ['PENDING', 'APPROVED'] })
      .andWhere('r.id != :excludeId', { excludeId })
      .getRawOne();

    const reserved = this._toNumber(row?.total);
    return Math.max(0, rawBalance - reserved);
  }

  _toNumber(value) {
    const n = parseFloat(value);
    return isNaN(n) ? 0 : n;
  }
}

Injectable()(TimeOffRequestsService);

module.exports.TimeOffRequestsService = TimeOffRequestsService;
module.exports.VALID_TRANSITIONS      = VALID_TRANSITIONS;