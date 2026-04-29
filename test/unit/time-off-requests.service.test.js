/**
 * Unit Tests — TimeOffRequestsService
 *
 * All external dependencies mocked. Pure logic testing.
 *
 * Coverage targets (TRD §12 Layer 1):
 *   ✓ submit — happy path → PENDING
 *   ✓ submit — invalid days (zero/negative)
 *   ✓ submit — invalid date range (start > end)
 *   ✓ submit — insufficient local balance → 422
 *   ✓ approve — happy path → APPROVED + HCM confirmed
 *   ✓ approve — invalid transition (already APPROVED)
 *   ✓ approve — HCM balance insufficient after re-sync → auto-REJECTED
 *   ✓ approve — HCM unavailable → throws, request stays PENDING
 *   ✓ reject — happy path with reason
 *   ✓ reject — missing reason → 400
 *   ✓ reject — invalid transition (already REJECTED)
 *   ✓ cancel — happy path
 *   ✓ cancel — invalid transition (already CANCELLED)
 *   ✓ findById — found
 *   ✓ findById — not found → 404
 *   ✓ findByEmployee — filters correctly
 */

const { TimeOffRequestsService } = require('../../src/time-off-requests/time-off-requests.service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequestRepo(overrides = {}) {
  return {
    findOne:            jest.fn(),
    find:               jest.fn(),
    create:             jest.fn((data) => data),
    save:               jest.fn((entity) => Promise.resolve({ id: 99, ...entity })),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function makeBalancesService(overrides = {}) {
  return {
    checkAvailableBalance: jest.fn(),
    upsertFromHcm:         jest.fn(),
    deductBalance:         jest.fn(),
    ...overrides,
  };
}

function makeHcmService(overrides = {}) {
  return {
    getBalance:      jest.fn(),
    submitDeduction: jest.fn(),
    ...overrides,
  };
}

function pendingRequest(overrides = {}) {
  return {
    id:          1,
    employeeId:  'emp-1',
    locationId:  'loc-1',
    startDate:   '2026-05-01',
    endDate:     '2026-05-05',
    days:        5,
    status:      'PENDING',
    hcmConfirmed: false,
    ...overrides,
  };
}

function makeQueryBuilder(total = null) {
  return {
    select:    jest.fn().mockReturnThis(),
    where:     jest.fn().mockReturnThis(),
    andWhere:  jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ total }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimeOffRequestsService', () => {
  let requestRepo;
  let balancesService;
  let hcmService;
  let service;

  beforeEach(() => {
    requestRepo     = makeRequestRepo();
    balancesService = makeBalancesService();
    hcmService      = makeHcmService();
    service         = new TimeOffRequestsService(requestRepo, balancesService, hcmService);
  });

  // ── findById ────────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the request when found', async () => {
      const req = pendingRequest();
      requestRepo.findOne.mockResolvedValue(req);

      const result = await service.findById(1);
      expect(result).toEqual(req);
    });

    it('throws NotFoundException when request does not exist', async () => {
      requestRepo.findOne.mockResolvedValue(null);

      await expect(service.findById(999))
        .rejects.toMatchObject({ message: expect.stringContaining('not found') });
    });
  });

  // ── findByEmployee ──────────────────────────────────────────────────────────

  describe('findByEmployee', () => {
    it('returns all requests for an employee', async () => {
      const requests = [pendingRequest(), pendingRequest({ id: 2 })];
      requestRepo.find.mockResolvedValue(requests);

      const result = await service.findByEmployee('emp-1');
      expect(result).toHaveLength(2);
      expect(requestRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ employeeId: 'emp-1' }) })
      );
    });

    it('adds locationId filter when provided', async () => {
      requestRepo.find.mockResolvedValue([]);

      await service.findByEmployee('emp-1', 'loc-1');

      expect(requestRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ employeeId: 'emp-1', locationId: 'loc-1' })
        })
      );
    });
  });

  // ── submit ──────────────────────────────────────────────────────────────────

  describe('submit', () => {
    const validPayload = {
      employeeId: 'emp-1',
      locationId: 'loc-1',
      startDate:  '2026-05-01',
      endDate:    '2026-05-05',
      days:       5,
      reason:     'Vacation',
    };

    it('creates a PENDING request when balance is sufficient', async () => {
      balancesService.checkAvailableBalance.mockResolvedValue({ available: 10, sufficient: true });
      requestRepo.save.mockResolvedValue({ id: 1, status: 'PENDING' });

      const result = await service.submit(validPayload);

      expect(result.status).toBe('PENDING');
      expect(result.id).toBeDefined();
      expect(requestRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PENDING', hcmConfirmed: false })
      );
    });

    it('throws BadRequestException when days is zero', async () => {
      await expect(service.submit({ ...validPayload, days: 0 }))
        .rejects.toMatchObject({ message: expect.stringContaining('positive integer') });
    });

    it('throws BadRequestException when days is negative', async () => {
      await expect(service.submit({ ...validPayload, days: -3 }))
        .rejects.toMatchObject({ message: expect.stringContaining('positive integer') });
    });

    it('throws BadRequestException when startDate is after endDate', async () => {
      await expect(service.submit({ ...validPayload, startDate: '2026-05-10', endDate: '2026-05-01' }))
        .rejects.toMatchObject({ message: expect.stringContaining('on or before') });
    });

    it('throws UnprocessableEntityException when available balance is insufficient', async () => {
      balancesService.checkAvailableBalance.mockResolvedValue({ available: 3, sufficient: false });

      await expect(service.submit(validPayload))
        .rejects.toMatchObject({
          message: expect.stringContaining('Available balance'),
        });
    });

    it('does not call HCM during submission (optimistic local check only)', async () => {
      balancesService.checkAvailableBalance.mockResolvedValue({ available: 10, sufficient: true });
      requestRepo.save.mockResolvedValue({ id: 1, status: 'PENDING' });

      await service.submit(validPayload);

      expect(hcmService.getBalance).not.toHaveBeenCalled();
      expect(hcmService.submitDeduction).not.toHaveBeenCalled();
    });
  });

  // ── approve ─────────────────────────────────────────────────────────────────

  describe('approve', () => {
    it('approves request and calls HCM deduction on happy path', async () => {
      const req = pendingRequest({ days: 5 });
      requestRepo.findOne.mockResolvedValue(req);
      hcmService.getBalance.mockResolvedValue({ balance: 20 });
      balancesService.upsertFromHcm.mockResolvedValue({});
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null)); // no other reserved
      hcmService.submitDeduction.mockResolvedValue({ success: true });
      balancesService.deductBalance.mockResolvedValue(undefined);
      requestRepo.save.mockResolvedValue({ ...req, status: 'APPROVED', hcmConfirmed: true });

      const result = await service.approve(1);

      expect(hcmService.getBalance).toHaveBeenCalledWith('emp-1', 'loc-1');
      expect(hcmService.submitDeduction).toHaveBeenCalledWith('emp-1', 'loc-1', 5);
      expect(balancesService.deductBalance).toHaveBeenCalledWith('emp-1', 'loc-1', 5);
      expect(result.status).toBe('APPROVED');
      expect(result.hcmConfirmed).toBe(true);
    });

    it('throws BadRequestException for invalid transition (APPROVED → APPROVED)', async () => {
      requestRepo.findOne.mockResolvedValue(pendingRequest({ status: 'APPROVED' }));

      await expect(service.approve(1))
        .rejects.toMatchObject({ message: expect.stringContaining('Cannot transition') });
    });

    it('auto-rejects and throws ConflictException when HCM balance insufficient after re-sync', async () => {
      const req = pendingRequest({ days: 15 });
      requestRepo.findOne.mockResolvedValue(req);
      hcmService.getBalance.mockResolvedValue({ balance: 5 }); // HCM only has 5
      balancesService.upsertFromHcm.mockResolvedValue({});
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null));
      requestRepo.save.mockResolvedValue({ ...req, status: 'REJECTED' });

      await expect(service.approve(1))
        .rejects.toMatchObject({ message: expect.stringContaining('insufficient') });

      // request should have been saved as REJECTED
      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'REJECTED' })
      );
    });

    it('throws and leaves request PENDING when HCM is unavailable', async () => {
      const req = pendingRequest({ days: 5 });
      requestRepo.findOne.mockResolvedValue(req);
      hcmService.getBalance.mockRejectedValue(new Error('HCM_UNAVAILABLE'));

      await expect(service.approve(1)).rejects.toThrow();

      // request must NOT have been saved as APPROVED
      expect(requestRepo.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'APPROVED' })
      );
    });

    it('throws when HCM submitDeduction fails (no double deduction risk)', async () => {
      const req = pendingRequest({ days: 5 });
      requestRepo.findOne.mockResolvedValue(req);
      hcmService.getBalance.mockResolvedValue({ balance: 20 });
      balancesService.upsertFromHcm.mockResolvedValue({});
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null));
      hcmService.submitDeduction.mockRejectedValue(new Error('HCM_UNAVAILABLE'));

      await expect(service.approve(1)).rejects.toThrow();

      // local balance must NOT have been deducted
      expect(balancesService.deductBalance).not.toHaveBeenCalled();
    });
  });

  // ── reject ──────────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('rejects a PENDING request with a reason', async () => {
      const req = pendingRequest();
      requestRepo.findOne.mockResolvedValue(req);
      requestRepo.save.mockResolvedValue({ ...req, status: 'REJECTED', rejectionReason: 'Understaffed' });

      const result = await service.reject(1, 'Understaffed');

      expect(result.status).toBe('REJECTED');
      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'REJECTED', rejectionReason: 'Understaffed' })
      );
    });

    it('throws BadRequestException when reason is missing', async () => {
      await expect(service.reject(1, ''))
        .rejects.toMatchObject({ message: expect.stringContaining('reason is required') });
    });

    it('throws BadRequestException when reason is only whitespace', async () => {
      await expect(service.reject(1, '   '))
        .rejects.toMatchObject({ message: expect.stringContaining('reason is required') });
    });

    it('throws BadRequestException for invalid transition (REJECTED → REJECTED)', async () => {
      requestRepo.findOne.mockResolvedValue(pendingRequest({ status: 'REJECTED' }));

      await expect(service.reject(1, 'some reason'))
        .rejects.toMatchObject({ message: expect.stringContaining('Cannot transition') });
    });

    it('throws BadRequestException for invalid transition (APPROVED → REJECTED)', async () => {
      requestRepo.findOne.mockResolvedValue(pendingRequest({ status: 'APPROVED' }));

      await expect(service.reject(1, 'some reason'))
        .rejects.toMatchObject({ message: expect.stringContaining('Cannot transition') });
    });
  });

  // ── cancel ──────────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('cancels a PENDING request', async () => {
      const req = pendingRequest();
      requestRepo.findOne.mockResolvedValue(req);
      requestRepo.save.mockResolvedValue({ ...req, status: 'CANCELLED' });

      const result = await service.cancel(1);

      expect(result.status).toBe('CANCELLED');
    });

    it('throws BadRequestException for invalid transition (CANCELLED → CANCELLED)', async () => {
      requestRepo.findOne.mockResolvedValue(pendingRequest({ status: 'CANCELLED' }));

      await expect(service.cancel(1))
        .rejects.toMatchObject({ message: expect.stringContaining('Cannot transition') });
    });

    it('throws BadRequestException for invalid transition (APPROVED → CANCELLED)', async () => {
      requestRepo.findOne.mockResolvedValue(pendingRequest({ status: 'APPROVED' }));

      await expect(service.cancel(1))
        .rejects.toMatchObject({ message: expect.stringContaining('Cannot transition') });
    });

    it('throws BadRequestException for invalid transition (REJECTED → CANCELLED)', async () => {
      requestRepo.findOne.mockResolvedValue(pendingRequest({ status: 'REJECTED' }));

      await expect(service.cancel(1))
        .rejects.toMatchObject({ message: expect.stringContaining('Cannot transition') });
    });
  });

  // ── state machine completeness ───────────────────────────────────────────────

  describe('state machine — VALID_TRANSITIONS', () => {
    it('only allows PENDING → APPROVED, REJECTED, CANCELLED', async () => {
      const { VALID_TRANSITIONS } = require('../../src/time-off-requests/time-off-requests.service');
      expect(VALID_TRANSITIONS.PENDING).toEqual(
        expect.arrayContaining(['APPROVED', 'REJECTED', 'CANCELLED'])
      );
      expect(VALID_TRANSITIONS.PENDING).toHaveLength(3);
    });

    it('APPROVED, REJECTED, CANCELLED are terminal states (no further transitions)', () => {
      const { VALID_TRANSITIONS } = require('../../src/time-off-requests/time-off-requests.service');
      expect(VALID_TRANSITIONS.APPROVED).toHaveLength(0);
      expect(VALID_TRANSITIONS.REJECTED).toHaveLength(0);
      expect(VALID_TRANSITIONS.CANCELLED).toHaveLength(0);
    });
  });
});