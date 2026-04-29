/**
 * Unit Tests — BalancesService
 *
 * All external dependencies (TypeORM repositories, HcmService) are manually
 * mocked. No database, no HTTP. Pure logic.
 *
 * Coverage targets (TRD §12 Layer 1):
 *   ✓ getBalance — fresh record (not stale)
 *   ✓ getBalance — stale record triggers HCM refresh
 *   ✓ getBalance — missing record triggers HCM refresh
 *   ✓ availableBalance subtracts PENDING + APPROVED requests
 *   ✓ upsertFromHcm — creates new record
 *   ✓ upsertFromHcm — updates existing record with version increment
 *   ✓ upsertFromHcm — detects concurrent modification (version conflict)
 *   ✓ deductBalance — happy path
 *   ✓ deductBalance — throws when balance not found
 *   ✓ deductBalance — throws when deduction would go negative
 *   ✓ deductBalance — detects concurrent modification
 *   ✓ checkAvailableBalance — sufficient
 *   ✓ checkAvailableBalance — insufficient
 */

const { BalancesService } = require("../../src/balances/balances.service");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(overrides = {}) {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn((entity) => Promise.resolve(entity)),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function makeHcmService(overrides = {}) {
  return {
    getBalance: jest.fn(),
    submitDeduction: jest.fn(),
    ...overrides,
  };
}

function makeQueryBuilder(total = null) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ total }),
  };
  return qb;
}

function freshBalance(overrides = {}) {
  return {
    id: 1,
    employeeId: "emp-1",
    locationId: "loc-1",
    balance: "20.00",
    version: 1,
    lastSyncedAt: new Date(), // just now → not stale
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BalancesService", () => {
  let balanceRepo;
  let requestRepo;
  let hcmService;
  let service;

  beforeEach(() => {
    balanceRepo = makeRepo();
    requestRepo = makeRepo();
    hcmService = makeHcmService();
    service = new BalancesService(balanceRepo, hcmService, requestRepo);
  });

  // ── getBalance ──────────────────────────────────────────────────────────────

  describe("getBalance", () => {
    it("returns balance without HCM call when local record is fresh", async () => {
      const balance = freshBalance({ balance: "18.00" });
      balanceRepo.findOne.mockResolvedValue(balance);

      // query builder for _computeAvailableBalance (no reserved requests)
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null));

      const result = await service.getBalance("emp-1", "loc-1");

      expect(hcmService.getBalance).not.toHaveBeenCalled();
      expect(result.balance).toBe(18);
      expect(result.availableBalance).toBe(18);
      expect(result.employeeId).toBe("emp-1");
      expect(result.locationId).toBe("loc-1");
    });

    it("calls HCM and refreshes when local record is stale (>15 min old)", async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
      const staleBalance = freshBalance({
        lastSyncedAt: staleDate,
        balance: "10.00",
      });

      balanceRepo.findOne
        .mockResolvedValueOnce(staleBalance) // first call — stale record
        .mockResolvedValueOnce(staleBalance); // second call inside upsertFromHcm

      hcmService.getBalance.mockResolvedValue({ balance: 15 });
      balanceRepo.update.mockResolvedValue({ affected: 1 });
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null));

      const result = await service.getBalance("emp-1", "loc-1");

      expect(hcmService.getBalance).toHaveBeenCalledWith("emp-1", "loc-1");
      expect(result.balance).toBe(15);
    });

    it("calls HCM and creates record when no local record exists", async () => {
      balanceRepo.findOne
        .mockResolvedValueOnce(null) // first call — no record
        .mockResolvedValueOnce(null); // inside upsertFromHcm

      hcmService.getBalance.mockResolvedValue({ balance: 12 });
      balanceRepo.save.mockResolvedValue({
        employeeId: "emp-1",
        locationId: "loc-1",
        balance: "12.00",
        version: 1,
        lastSyncedAt: new Date(),
      });
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null));

      const result = await service.getBalance("emp-1", "loc-1");

      expect(hcmService.getBalance).toHaveBeenCalledWith("emp-1", "loc-1");
      expect(result.balance).toBe(12);
    });

    it("subtracts PENDING + APPROVED reserved days from availableBalance", async () => {
      const balance = freshBalance({ balance: "20.00" });
      balanceRepo.findOne.mockResolvedValue(balance);

      // 5 days reserved (pending + approved requests)
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder("5"));

      const result = await service.getBalance("emp-1", "loc-1");

      expect(result.balance).toBe(20);
      expect(result.availableBalance).toBe(15); // 20 - 5
    });

    it("availableBalance never goes below zero", async () => {
      const balance = freshBalance({ balance: "3.00" });
      balanceRepo.findOne.mockResolvedValue(balance);

      // 10 days reserved — more than balance
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder("10"));

      const result = await service.getBalance("emp-1", "loc-1");

      expect(result.availableBalance).toBe(0);
    });
  });

  // ── upsertFromHcm ───────────────────────────────────────────────────────────

  describe("upsertFromHcm", () => {
    it("creates a new balance record when none exists", async () => {
      balanceRepo.findOne.mockResolvedValue(null);
      const saved = {
        employeeId: "emp-1",
        locationId: "loc-1",
        balance: "20.00",
        version: 1,
        lastSyncedAt: new Date(),
      };
      balanceRepo.save.mockResolvedValue(saved);

      const result = await service.upsertFromHcm("emp-1", "loc-1", 20);

      expect(balanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: "emp-1",
          locationId: "loc-1",
          balance: 20,
          version: 1,
        }),
      );
      expect(balanceRepo.save).toHaveBeenCalled();
      expect(result).toEqual(saved);
    });

    it("updates existing record and increments version", async () => {
      const existing = freshBalance({ version: 3, balance: "10.00" });
      balanceRepo.findOne.mockResolvedValue(existing);
      balanceRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.upsertFromHcm("emp-1", "loc-1", 20);

      expect(balanceRepo.update).toHaveBeenCalledWith(
        { id: existing.id, version: 3 },
        expect.objectContaining({ balance: 20, version: 4 }),
      );
      expect(result.version).toBe(4);
      expect(result.balance).toBe(20);
    });

    it("throws ConflictException when version conflict detected (affected=0)", async () => {
      const existing = freshBalance({ version: 2 });
      balanceRepo.findOne.mockResolvedValue(existing);
      balanceRepo.update.mockResolvedValue({ affected: 0 }); // concurrent write won

      await expect(
        service.upsertFromHcm("emp-1", "loc-1", 20),
      ).rejects.toMatchObject({
        message: expect.stringContaining("concurrently"),
      });
    });
  });

  // ── deductBalance ───────────────────────────────────────────────────────────

  describe("deductBalance", () => {
    it("deducts days and increments version", async () => {
      const balance = freshBalance({ balance: "20.00", version: 1 });
      balanceRepo.findOne.mockResolvedValue(balance);
      balanceRepo.update.mockResolvedValue({ affected: 1 });

      await service.deductBalance("emp-1", "loc-1", 5);

      expect(balanceRepo.update).toHaveBeenCalledWith(
        { id: balance.id, version: 1 },
        expect.objectContaining({ balance: 15, version: 2 }),
      );
    });

    it("throws NotFoundException when no balance record exists", async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deductBalance("emp-1", "loc-1", 5),
      ).rejects.toMatchObject({
        message: expect.stringContaining("No balance found"),
      });
    });

    it("throws UnprocessableEntityException when deduction would go negative", async () => {
      const balance = freshBalance({ balance: "3.00" });
      balanceRepo.findOne.mockResolvedValue(balance);

      await expect(
        service.deductBalance("emp-1", "loc-1", 5),
      ).rejects.toMatchObject({
        message: expect.stringContaining("negative balance"),
      });
    });

    it("throws ConflictException when concurrent modification detected", async () => {
      const balance = freshBalance({ balance: "20.00" });
      balanceRepo.findOne.mockResolvedValue(balance);
      balanceRepo.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.deductBalance("emp-1", "loc-1", 5),
      ).rejects.toMatchObject({
        message: expect.stringContaining("concurrently"),
      });
    });
  });

  // ── checkAvailableBalance ───────────────────────────────────────────────────

  describe("checkAvailableBalance", () => {
    it("returns sufficient=true when available balance >= requested days", async () => {
      balanceRepo.findOne.mockResolvedValue(freshBalance({ balance: "20.00" }));
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder("5")); // 5 reserved

      const result = await service.checkAvailableBalance("emp-1", "loc-1", 10);

      expect(result.available).toBe(15); // 20 - 5
      expect(result.sufficient).toBe(true);
    });

    it("returns sufficient=false when available balance < requested days", async () => {
      balanceRepo.findOne.mockResolvedValue(freshBalance({ balance: "8.00" }));
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder("5")); // 5 reserved

      const result = await service.checkAvailableBalance("emp-1", "loc-1", 10);

      expect(result.available).toBe(3); // 8 - 5
      expect(result.sufficient).toBe(false);
    });

    it("returns available=0 and sufficient=false when no local balance exists", async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      // mock HCM returning 0 balance for unknown employee
      hcmService.getBalance.mockResolvedValue({ balance: 0 });
      balanceRepo.save.mockResolvedValue({
        employeeId: "emp-1",
        locationId: "loc-1",
        balance: "0.00",
        version: 1,
        lastSyncedAt: new Date(),
      });
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(null));

      const result = await service.checkAvailableBalance("emp-1", "loc-1", 5);

      expect(result.available).toBe(0);
      expect(result.sufficient).toBe(false);
    });

    it("handles SQLite returning balance as string (decimal coercion)", async () => {
      balanceRepo.findOne.mockResolvedValue(freshBalance({ balance: "12.50" }));
      requestRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder("2.5"));

      const result = await service.checkAvailableBalance("emp-1", "loc-1", 5);

      expect(result.available).toBe(10); // 12.5 - 2.5
      expect(result.sufficient).toBe(true);
    });
  });
});
