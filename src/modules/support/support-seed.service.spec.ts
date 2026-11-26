import {
  INITIAL_SUPPORT_CATEGORIES,
  SupportSeedService,
} from './support-seed.service';
import { SupportService } from './support.service';

describe('BUG-CUST-017: Safety Support Category and Ticket Creation', () => {
  describe('INITIAL_SUPPORT_CATEGORIES', () => {
    it('includes SAFETY_ISSUE category with label "Report a Safety Issue"', () => {
      const safety = INITIAL_SUPPORT_CATEGORIES.find((c) => c.code === 'SAFETY_ISSUE');
      expect(safety).toBeDefined();
      expect(safety).toEqual({
        code: 'SAFETY_ISSUE',
        name: 'Report a Safety Issue',
      });
      expect(INITIAL_SUPPORT_CATEGORIES.map((c) => c.code)).toEqual([
        'SAFETY_ISSUE',
        'BOOKING_ISSUE',
        'PAYMENT_ISSUE',
        'WORKER_CONDUCT',
        'APP_PROBLEM',
        'OTHER',
      ]);
    });
  });

  describe('SupportSeedService.ensureInitialCategories', () => {
    it('creates missing support categories idempotently', async () => {
      const stored = new Map<string, { id: string; code: string; name: string; isEnabled: boolean }>();
      const created: Array<{ code: string; name: string }> = [];

      const repository = {
        findCategoryByCode: jest.fn((code: string) => Promise.resolve(stored.get(code) ?? null)),
        createCategory: jest.fn((input: { code: string; name: string }) => {
          const row = { id: `id-${input.code}`, ...input, isEnabled: true };
          stored.set(input.code, row);
          created.push(input);
          return Promise.resolve(row);
        }),
      };

      const seedService = new SupportSeedService(repository as never);

      const count = await seedService.ensureInitialCategories();
      expect(count).toBe(6);
      expect(created).toHaveLength(6);
      expect(created.map((c) => c.code)).toContain('SAFETY_ISSUE');

      // Second run: idempotent, changes nothing
      const secondCount = await seedService.ensureInitialCategories();
      expect(secondCount).toBe(0);
      expect(created).toHaveLength(6);
    });
  });

  describe('SupportService with Safety Category', () => {
    let supportService: SupportService;
    let mockRepo: {
      listCategories: jest.Mock;
      findCategory: jest.Mock;
      transaction: jest.Mock;
      create: jest.Mock;
      addEvent: jest.Mock;
      findById: jest.Mock;
      lock: jest.Mock;
      update: jest.Mock;
      events: jest.Mock;
      listEvents: jest.Mock;
      listMessages: jest.Mock;
      countMessages: jest.Mock;
    };
    let mockAudit: { record: jest.Mock };
    let mockOutbox: { notify: jest.Mock };
    let mockAlerts: { raise: jest.Mock; autoResolve: jest.Mock };

    beforeEach(() => {
      mockRepo = {
        listCategories: jest.fn(() =>
          Promise.resolve([
            { id: 'cat-safety', code: 'SAFETY_ISSUE', name: 'Report a Safety Issue', isEnabled: true },
            { id: 'cat-booking', code: 'BOOKING_ISSUE', name: 'Booking issue', isEnabled: true },
          ]),
        ),
        findCategory: jest.fn((id: string) => {
          if (id === 'cat-safety') {
            return Promise.resolve({
              id: 'cat-safety',
              code: 'SAFETY_ISSUE',
              name: 'Report a Safety Issue',
              isEnabled: true,
            });
          }
          return Promise.resolve(null);
        }),
        transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
        create: jest.fn((input: { categoryId: string; description: string }) =>
          Promise.resolve({
            id: 'ticket-safety-1',
            creatorUserId: 'cust-user-1',
            creatorKind: 'CUSTOMER',
            bookingId: null,
            categoryId: input.categoryId,
            subject: 'Safety emergency',
            description: input.description,
            status: 'OPEN',
            priority: null,
            resolution: null,
            dueAt: null,
            closedAt: null,
            closedByUserId: null,
            slaBreachedAt: null,
            category: { id: 'cat-safety', code: 'SAFETY_ISSUE', name: 'Report a Safety Issue' },
            events: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
        addEvent: jest.fn(() => Promise.resolve({})),
        findById: jest.fn(() =>
          Promise.resolve({
            id: 'ticket-safety-1',
            creatorUserId: 'cust-user-1',
            creatorKind: 'CUSTOMER',
            bookingId: null,
            categoryId: 'cat-safety',
            subject: 'Safety emergency',
            description: 'Suspicious individual visited premises',
            status: 'OPEN',
            priority: null,
            resolution: null,
            dueAt: null,
            closedAt: null,
            closedByUserId: null,
            slaBreachedAt: null,
            category: { id: 'cat-safety', code: 'SAFETY_ISSUE', name: 'Report a Safety Issue' },
            events: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
        lock: jest.fn(() =>
          Promise.resolve({
            id: 'ticket-safety-1',
            status: 'OPEN',
            category: { id: 'cat-safety', code: 'SAFETY_ISSUE', name: 'Report a Safety Issue' },
          }),
        ),
        update: jest.fn(() => Promise.resolve({})),
        events: jest.fn(() => Promise.resolve([])),
        listEvents: jest.fn(() => Promise.resolve([])),
        listMessages: jest.fn(() => Promise.resolve([])),
        countMessages: jest.fn(() => Promise.resolve(0)),
      };

      mockAudit = { record: jest.fn(() => Promise.resolve()) };
      mockOutbox = { notify: jest.fn(() => Promise.resolve()) };
      mockAlerts = { raise: jest.fn(() => Promise.resolve()), autoResolve: jest.fn(() => Promise.resolve()) };

      const mockBookings = {};
      const mockWorkers = {};
      const mockUsers = {};
      const mockConfig = { ops: { supportSlaHours: { default: null } } };

      supportService = new SupportService(
        mockRepo as never,
        mockBookings as never,
        mockWorkers as never,
        mockUsers as never,
        mockAudit as never,
        mockOutbox as never,
        mockAlerts as never,
        mockConfig as never,
      );
    });

    it('listCategories exposes isSafety: true for SAFETY_ISSUE category', async () => {
      const categories = await supportService.listCategories();
      expect(categories).toHaveLength(2);
      const safety = categories.find((c) => c.code === 'SAFETY_ISSUE');
      expect(safety).toBeDefined();
      expect(safety?.isSafety).toBe(true);

      const booking = categories.find((c) => c.code === 'BOOKING_ISSUE');
      expect(booking?.isSafety).toBe(false);
    });

    it('creates safety ticket, resolves category, and records audit trail with categoryCode', async () => {
      const result = await supportService.create(
        { userId: 'cust-user-1', kind: 'CUSTOMER' },
        {
          categoryId: 'cat-safety',
          subject: 'Safety emergency',
          description: 'Suspicious individual visited premises during service',
        },
      );

      expect(result).toBeDefined();
      expect(result.id).toBe('ticket-safety-1');
      expect(result.category.code).toBe('SAFETY_ISSUE');
      expect(result.category.isSafety).toBe(true);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ticket.create',
          metadata: expect.objectContaining({
            categoryCode: 'SAFETY_ISSUE',
          }),
        }),
        expect.anything(),
      );
    });

    it('escalates a safety ticket with staff authorization', async () => {
      const escalated = await supportService.escalate(
        'ticket-safety-1',
        'Immediate threat assessment required',
        { userId: 'staff-admin-1', roles: ['SUPPORT'] },
      );

      expect(mockRepo.update).toHaveBeenCalledWith(
        'ticket-safety-1',
        expect.objectContaining({ status: 'ESCALATED' }),
        expect.anything(),
      );
      expect(mockRepo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ESCALATED',
          toStatus: 'ESCALATED',
          internalNote: 'Immediate threat assessment required',
        }),
        expect.anything(),
      );
      expect(escalated).toBeDefined();
    });
  });
});
