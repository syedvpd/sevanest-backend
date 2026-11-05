import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { BookingErrorCode, BookingService, type BookingActor } from './booking.service';
import { WorkerBookingsController } from './booking.controller';
import type { BookingRecord } from './booking.repository';
import type { BookingStatusValue } from './dto/booking.dto';
import type { InterviewRecord } from './interview.repository';

describe('Adversarial Stress Suite — Worker Opportunity Acceptance & Booking State Machine', () => {
  let bookingService: BookingService;
  let workerController: WorkerBookingsController;

  let mockRepo: {
    transaction: jest.Mock;
    lock: jest.Mock;
    findById: jest.Mock;
    update: jest.Mock;
    addEvent: jest.Mock;
    listEvents: jest.Mock;
    list: jest.Mock;
  };
  let mockInterviews: {
    findOpen: jest.Mock;
    update: jest.Mock;
    cancelOpen: jest.Mock;
  };
  let mockOutbox: {
    notify: jest.Mock;
  };
  let mockAudit: {
    record: jest.Mock;
  };
  let mockAlerts: {
    autoResolve: jest.Mock;
  };
  let mockCategories: {
    findByIds: jest.Mock;
  };
  let mockAreas: {
    findByIds: jest.Mock;
  };
  let mockWorkers: {
    namesByIds: jest.Mock;
    requireRefById: jest.Mock;
    requireRefByUserId: jest.Mock;
  };

  const assignedWorkerActor: BookingActor = {
    kind: 'WORKER',
    userId: 'worker-user-1',
    workerId: 'worker-profile-1',
  };

  const otherWorkerActor: BookingActor = {
    kind: 'WORKER',
    userId: 'worker-user-2',
    workerId: 'worker-profile-2',
  };

  const customerActor: BookingActor = {
    kind: 'CUSTOMER',
    userId: 'customer-user-1',
  };

  const otherCustomerActor: BookingActor = {
    kind: 'CUSTOMER',
    userId: 'customer-user-2',
  };

  const now = new Date('2026-11-05T06:30:00.000Z');

  const baseBooking: BookingRecord = {
    id: '01a1aa1c-5c3e-73ab-a73a-dd1d4a9d39b5',
    customerUserId: 'customer-user-1',
    categoryId: 'cat-1',
    areaId: 'area-1',
    engagement: 'ONE_TIME',
    fromMinute: 540,
    toMinute: 660,
    workerId: 'worker-profile-1',
    status: 'MATCHED',
    scheduleType: null,
    scheduledAt: null,
    startDate: null,
    requestedStartDate: null,
    budgetMinMinor: null,
    budgetMaxMinor: null,
    budgetPeriod: null,
    requirementNote: 'Elderly care assistance',
    workerRespondedAt: null,
    respondBy: null,
    proposedSlotAt: null,
    proposedSlotNote: null,
    addressId: 'addr-1',
    outcomeNote: null,
    cancelReason: null,
    cancelledAt: null,
    cancelledByUserId: null,
    replacesBookingId: null,
    idempotencyKey: null,
    requestHash: 'hash-1',
    createdAt: now,
    updatedAt: now,
  };

  const openInterview: InterviewRecord = {
    id: 'interview-uuid-1',
    bookingId: '01a1aa1c-5c3e-73ab-a73a-dd1d4a9d39b5',
    type: 'INTERVIEW',
    status: 'REQUESTED',
    requestedByKind: 'CUSTOMER',
    requestedByUserId: 'customer-user-1',
    preferredAt: new Date('2026-11-06T11:00:00.000Z'),
    scheduledAt: null,
    proposedAt: null,
    proposedByKind: null,
    note: null,
    declineReason: null,
    cancelReason: null,
    outcomeNote: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(() => {
    mockRepo = {
      transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
      lock: jest.fn(() => Promise.resolve({ ...baseBooking })),
      findById: jest.fn(() => Promise.resolve({ ...baseBooking })),
      update: jest.fn(() => Promise.resolve({ ...baseBooking })),
      addEvent: jest.fn(() => Promise.resolve({})),
      listEvents: jest.fn(() => Promise.resolve([])),
      list: jest.fn(() => Promise.resolve({ items: [{ ...baseBooking }], total: 1 })),
    };

    mockInterviews = {
      findOpen: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({ ...openInterview, status: 'CONFIRMED' })),
      cancelOpen: jest.fn(() => Promise.resolve(undefined)),
    };

    mockOutbox = {
      notify: jest.fn(() => Promise.resolve(undefined)),
    };

    mockAudit = {
      record: jest.fn(() => Promise.resolve(undefined)),
    };

    mockAlerts = {
      autoResolve: jest.fn(() => Promise.resolve(undefined)),
    };

    mockCategories = {
      findByIds: jest.fn(() =>
        Promise.resolve([{ id: 'cat-1', code: 'ELDERLY_CARE', name: 'Elderly Care' }]),
      ),
    };

    mockAreas = {
      findByIds: jest.fn(() =>
        Promise.resolve([{ id: 'area-1', name: 'Koramangala', city: 'Bengaluru' }]),
      ),
    };

    mockWorkers = {
      namesByIds: jest.fn(() => Promise.resolve(new Map([['worker-profile-1', 'Annamma T.']]))),
      requireRefById: jest.fn(() =>
        Promise.resolve({
          userId: 'worker-user-1',
          workerId: 'worker-profile-1',
        }),
      ),
      requireRefByUserId: jest.fn((userId: string) => {
        if (userId === 'worker-user-1') {
          return Promise.resolve({ userId: 'worker-user-1', workerId: 'worker-profile-1' });
        }
        if (userId === 'worker-user-2') {
          return Promise.resolve({ userId: 'worker-user-2', workerId: 'worker-profile-2' });
        }
        throw new DomainException(
          BookingErrorCode.WORKER_NOT_ELIGIBLE,
          'Worker not found',
          HttpStatus.NOT_FOUND,
        );
      }),
    };

    const mockSearch = {
      photoLinks: jest.fn(() => Promise.resolve(new Map())),
      verifiedIds: jest.fn(() => Promise.resolve(new Set())),
    };

    bookingService = new BookingService(
      mockRepo as never,
      mockCategories as never,
      mockAreas as never,
      mockWorkers as never,
      mockSearch as never,
      mockAudit as never,
      mockOutbox as never,
      {
        ratedBookingIds: jest.fn(() => Promise.resolve(new Set())),
      } as never,
      {} as never,
      {} as never,
      mockAlerts as never,
      { ops: { bookingStartEarlyDays: 1, workerResponseHours: 24 } } as never,
      mockInterviews as never,
    );

    // Mock assertEligible internally for customer confirm-worker
    jest
      .spyOn(bookingService as never, 'assertEligible' as never)
      .mockResolvedValue(undefined as never);

    workerController = new WorkerBookingsController(bookingService, mockWorkers as never);
  });

  describe('Adversarial Dimension 1: Worker calling confirm-worker on non-MATCHED bookings', () => {
    const nonMatchedStatuses: BookingStatusValue[] = [
      'CONFIRMED',
      'ACTIVE',
      'COMPLETED',
      'CANCELLED',
      'INTERVIEW_TRIAL_SCHEDULED',
      'PENDING_PAYMENT',
      'REPLACEMENT_REQUESTED',
    ];

    test.each(nonMatchedStatuses)(
      'rejects worker confirm-worker on status %s with HTTP 403 ACTION_NOT_ALLOWED',
      async (status) => {
        mockRepo.lock.mockResolvedValueOnce({
          ...baseBooking,
          status,
          workerId: 'worker-profile-1',
        });

        await expect(
          bookingService.act(baseBooking.id, 'confirm-worker', {}, assignedWorkerActor),
        ).rejects.toMatchObject({
          code: BookingErrorCode.ACTION_NOT_ALLOWED,
          status: HttpStatus.FORBIDDEN,
          message: 'This action is not available to you',
        });

        expect(mockRepo.update).not.toHaveBeenCalled();
      },
    );

    it('worker confirm-worker on INTERVIEW_TRIAL_COMPLETED advances booking to PENDING_PAYMENT', async () => {
      const completedTrialBooking: BookingRecord = {
        ...baseBooking,
        status: 'INTERVIEW_TRIAL_COMPLETED',
      };
      mockRepo.lock.mockResolvedValueOnce({ ...completedTrialBooking });
      mockRepo.findById.mockResolvedValueOnce({
        ...completedTrialBooking,
        status: 'PENDING_PAYMENT',
        startDate: '2026-11-10',
      });

      const res = await bookingService.act(
        completedTrialBooking.id,
        'confirm-worker',
        { startDate: '2026-11-10' },
        assignedWorkerActor,
      );

      expect(res).toBeDefined();
      expect(mockRepo.update).toHaveBeenCalledWith(
        completedTrialBooking.id,
        expect.objectContaining({
          status: 'PENDING_PAYMENT',
          startDate: '2026-11-10',
        }),
        expect.anything(),
      );
    });

    it('rejects worker confirm-worker on NEW_REQUEST (not matched) with 404 or 403', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        status: 'NEW_REQUEST',
        workerId: null,
      });

      // worker does not own an unassigned booking -> 404
      await expect(
        bookingService.act(baseBooking.id, 'confirm-worker', {}, assignedWorkerActor),
      ).rejects.toMatchObject({
        code: BookingErrorCode.BOOKING_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('Adversarial Dimension 2: Customer calling confirm-worker (Regression & Flow Verification)', () => {
    it('customer calling confirm-worker on INTERVIEW_TRIAL_COMPLETED advances booking to PENDING_PAYMENT', async () => {
      const completedTrialBooking: BookingRecord = {
        ...baseBooking,
        status: 'INTERVIEW_TRIAL_COMPLETED',
      };
      mockRepo.lock.mockResolvedValueOnce({ ...completedTrialBooking });
      mockRepo.findById.mockResolvedValueOnce({
        ...completedTrialBooking,
        status: 'PENDING_PAYMENT',
        startDate: '2026-11-10',
      });

      const res = await bookingService.act(
        completedTrialBooking.id,
        'confirm-worker',
        { startDate: '2026-11-10' },
        customerActor,
      );

      expect(res).toBeDefined();
      expect(mockRepo.update).toHaveBeenCalledWith(
        completedTrialBooking.id,
        expect.objectContaining({
          status: 'PENDING_PAYMENT',
          startDate: '2026-11-10',
        }),
        expect.anything(),
      );
      expect(mockOutbox.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: NotificationEvent.BOOKING_PAYMENT_DUE,
          recipients: [completedTrialBooking.customerUserId],
        }),
        expect.anything(),
      );
    });

    it('customer calling confirm-worker on MATCHED rejects with 409 INVALID_TRANSITION', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        status: 'MATCHED',
      });

      await expect(
        bookingService.act(
          baseBooking.id,
          'confirm-worker',
          { startDate: '2026-11-10' },
          customerActor,
        ),
      ).rejects.toMatchObject({
        code: BookingErrorCode.INVALID_TRANSITION,
        status: HttpStatus.CONFLICT,
        message: expect.stringContaining('A booking that is MATCHED cannot confirm-worker'),
      });
    });

    it('customer calling accept directly rejects with 403 ACTION_NOT_ALLOWED', async () => {
      await expect(
        bookingService.act(baseBooking.id, 'accept', {}, customerActor),
      ).rejects.toMatchObject({
        code: BookingErrorCode.ACTION_NOT_ALLOWED,
        status: HttpStatus.FORBIDDEN,
        message: 'This action is not available to you',
      });
    });

    it('other customer calling confirm-worker rejects with 404 BOOKING_NOT_FOUND', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        status: 'INTERVIEW_TRIAL_COMPLETED',
      });

      await expect(
        bookingService.act(
          baseBooking.id,
          'confirm-worker',
          { startDate: '2026-11-10' },
          otherCustomerActor,
        ),
      ).rejects.toMatchObject({
        code: BookingErrorCode.BOOKING_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('Adversarial Dimension 3: Non-Assigned Worker Access Control', () => {
    it('non-assigned worker calling accept returns 404 BOOKING_NOT_FOUND', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        workerId: 'worker-profile-1', // assigned to worker 1
      });

      await expect(
        bookingService.act(baseBooking.id, 'accept', {}, otherWorkerActor),
      ).rejects.toMatchObject({
        code: BookingErrorCode.BOOKING_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
        message: 'Booking not found',
      });

      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('non-assigned worker calling confirm-worker returns 404 BOOKING_NOT_FOUND', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        workerId: 'worker-profile-1', // assigned to worker 1
      });

      await expect(
        bookingService.act(baseBooking.id, 'confirm-worker', {}, otherWorkerActor),
      ).rejects.toMatchObject({
        code: BookingErrorCode.BOOKING_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
        message: 'Booking not found',
      });

      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('worker attempting to accept booking with workerId: null returns 404', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        workerId: null,
      });

      await expect(
        bookingService.act(baseBooking.id, 'accept', {}, assignedWorkerActor),
      ).rejects.toMatchObject({
        code: BookingErrorCode.BOOKING_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('Adversarial Dimension 4: Idempotency & Repeat Invocations', () => {
    it('calling accept repeatedly on MATCHED booking (no interview) is idempotent and does not re-notify', async () => {
      const alreadyAcceptedBooking: BookingRecord = {
        ...baseBooking,
        status: 'MATCHED',
        workerRespondedAt: new Date('2026-11-05T07:00:00.000Z'),
      };
      mockRepo.lock.mockResolvedValueOnce({ ...alreadyAcceptedBooking });
      mockRepo.findById.mockResolvedValueOnce({ ...alreadyAcceptedBooking });

      const res = await bookingService.act(baseBooking.id, 'accept', {}, assignedWorkerActor);

      expect(res).toBeDefined();
      expect(mockRepo.update).not.toHaveBeenCalled();
      expect(mockOutbox.notify).not.toHaveBeenCalled();
    });

    it('calling confirm-worker repeatedly on MATCHED booking (no interview) is idempotent', async () => {
      const alreadyAcceptedBooking: BookingRecord = {
        ...baseBooking,
        status: 'MATCHED',
        workerRespondedAt: new Date('2026-11-05T07:00:00.000Z'),
      };
      mockRepo.lock.mockResolvedValueOnce({ ...alreadyAcceptedBooking });
      mockRepo.findById.mockResolvedValueOnce({ ...alreadyAcceptedBooking });

      const res = await bookingService.act(
        baseBooking.id,
        'confirm-worker',
        {},
        assignedWorkerActor,
      );

      expect(res).toBeDefined();
      expect(mockRepo.update).not.toHaveBeenCalled();
      expect(mockOutbox.notify).not.toHaveBeenCalled();
    });

    it('calling accept repeatedly on INTERVIEW_TRIAL_SCHEDULED replay succeeds idempotently', async () => {
      const scheduledBooking: BookingRecord = {
        ...baseBooking,
        status: 'INTERVIEW_TRIAL_SCHEDULED',
        scheduleType: 'INTERVIEW',
        scheduledAt: openInterview.preferredAt,
        workerRespondedAt: new Date('2026-11-05T07:00:00.000Z'),
      };
      mockRepo.lock.mockResolvedValueOnce({ ...scheduledBooking });
      mockRepo.findById.mockResolvedValueOnce({ ...scheduledBooking });

      const res = await bookingService.act(baseBooking.id, 'accept', {}, assignedWorkerActor);
      expect(res).toBeDefined();
      expect(mockRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('Adversarial Dimension 5: Interview State Synchronization', () => {
    it('when open interview is REQUESTED, acceptance confirms interview and sets booking to INTERVIEW_TRIAL_SCHEDULED', async () => {
      mockRepo.lock.mockResolvedValueOnce({ ...baseBooking });
      mockInterviews.findOpen.mockResolvedValueOnce({ ...openInterview });
      mockRepo.findById.mockResolvedValueOnce({
        ...baseBooking,
        status: 'INTERVIEW_TRIAL_SCHEDULED',
        scheduleType: 'INTERVIEW',
        scheduledAt: openInterview.preferredAt,
        workerRespondedAt: now,
      });

      await bookingService.act(baseBooking.id, 'accept', {}, assignedWorkerActor);

      expect(mockInterviews.update).toHaveBeenCalledWith(
        openInterview.id,
        {
          status: 'CONFIRMED',
          scheduledAt: openInterview.preferredAt,
        },
        expect.anything(),
      );

      expect(mockRepo.update).toHaveBeenCalledWith(
        baseBooking.id,
        expect.objectContaining({
          status: 'INTERVIEW_TRIAL_SCHEDULED',
          scheduleType: 'INTERVIEW',
          scheduledAt: openInterview.preferredAt,
          workerRespondedAt: expect.any(Date),
        }),
        expect.anything(),
      );

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'interview.accept',
          entityType: 'interview_trial',
          entityId: openInterview.id,
          actorId: assignedWorkerActor.userId,
        }),
        expect.anything(),
      );

      expect(mockOutbox.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: NotificationEvent.INTERVIEW_TRIAL_SCHEDULED,
          recipients: [baseBooking.customerUserId, assignedWorkerActor.userId],
          params: expect.objectContaining({
            bookingId: baseBooking.id,
            scheduleType: 'INTERVIEW',
            scheduledAt: openInterview.preferredAt.toISOString(),
          }),
        }),
        expect.anything(),
      );

      expect(mockOutbox.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: NotificationEvent.WORKER_ACCEPTED,
          recipients: [baseBooking.customerUserId],
        }),
        expect.anything(),
      );
    });

    it('when open interview is already CONFIRMED (not REQUESTED), worker accept falls through to regular accept', async () => {
      const alreadyConfirmedInterview: InterviewRecord = {
        ...openInterview,
        status: 'CONFIRMED',
        scheduledAt: openInterview.preferredAt,
      };
      mockRepo.lock.mockResolvedValueOnce({ ...baseBooking });
      mockInterviews.findOpen.mockResolvedValueOnce({ ...alreadyConfirmedInterview });
      mockRepo.findById.mockResolvedValueOnce({
        ...baseBooking,
        workerRespondedAt: now,
      });

      await bookingService.act(baseBooking.id, 'accept', {}, assignedWorkerActor);

      // Interview should NOT be updated because it was not in REQUESTED
      expect(mockInterviews.update).not.toHaveBeenCalled();
      // Booking remains MATCHED with workerRespondedAt set
      expect(mockRepo.update).toHaveBeenCalledWith(
        baseBooking.id,
        expect.objectContaining({
          status: 'MATCHED',
          workerRespondedAt: expect.any(Date),
        }),
        expect.anything(),
      );
    });
  });

  describe('Adversarial Dimension 6: Disallowed Worker Actions', () => {
    test.each(['complete', 'cancel', 'reopen-matching', 'interview-complete'] as const)(
      'worker calling %s rejects with 403 ACTION_NOT_ALLOWED before inspecting state',
      async (disallowedAction) => {
        await expect(
          bookingService.act(baseBooking.id, disallowedAction, {}, assignedWorkerActor),
        ).rejects.toMatchObject({
          code: BookingErrorCode.ACTION_NOT_ALLOWED,
          status: HttpStatus.FORBIDDEN,
          message: 'This action is not available to you',
        });
        expect(mockRepo.lock).not.toHaveBeenCalled();
      },
    );
  });

  describe('Adversarial Dimension 7: Controller Integration & User Scoping', () => {
    it('WorkerBookingsController delegates confirm-worker for assigned worker successfully', async () => {
      mockRepo.lock.mockResolvedValueOnce({ ...baseBooking });
      mockRepo.findById.mockResolvedValueOnce({
        ...baseBooking,
        workerRespondedAt: now,
      });

      const user = { userId: 'worker-user-1', appType: 'WORKER', roles: ['WORKER'] };
      const view = await workerController.act(baseBooking.id, 'confirm-worker', {}, user as never);

      expect(view).toBeDefined();
      expect(view.id).toBe(baseBooking.id);
      expect(mockRepo.update).toHaveBeenCalledWith(
        baseBooking.id,
        expect.objectContaining({
          status: 'MATCHED',
          workerRespondedAt: expect.any(Date),
        }),
        expect.anything(),
      );
    });

    it('WorkerBookingsController rejects worker confirm-worker on non-MATCHED with 403', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        status: 'CONFIRMED',
      });

      const user = { userId: 'worker-user-1', appType: 'WORKER', roles: ['WORKER'] };
      await expect(
        workerController.act(baseBooking.id, 'confirm-worker', {}, user as never),
      ).rejects.toMatchObject({
        code: BookingErrorCode.ACTION_NOT_ALLOWED,
        status: HttpStatus.FORBIDDEN,
      });
    });

    it('WorkerBookingsController rejects other worker with 404', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseBooking,
        workerId: 'worker-profile-1', // assigned to worker 1
      });

      const user = { userId: 'worker-user-2', appType: 'WORKER', roles: ['WORKER'] };
      await expect(
        workerController.act(baseBooking.id, 'confirm-worker', {}, user as never),
      ).rejects.toMatchObject({
        code: BookingErrorCode.BOOKING_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });
  });
});
