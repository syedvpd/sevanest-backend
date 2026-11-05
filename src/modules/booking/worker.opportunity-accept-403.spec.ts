import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { BookingErrorCode, BookingService, actionsFor, type BookingActor } from './booking.service';
import { WorkerBookingsController } from './booking.controller';
import { toInterviewView } from './interview.service';
import type { BookingRecord } from './booking.repository';
import type { InterviewRecord } from './interview.repository';

describe('Worker Opportunity Acceptance Fix (HTTP 403 ACTION_NOT_ALLOWED Resolution)', () => {
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

  const workerActor: BookingActor = {
    kind: 'WORKER',
    userId: 'worker-user-1',
    workerId: 'worker-profile-1',
  };

  const customerActor: BookingActor = {
    kind: 'CUSTOMER',
    userId: 'customer-user-1',
  };

  const now = new Date('2026-11-05T06:30:00.000Z');

  const baseMatchedBooking: BookingRecord = {
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
    requirementNote: 'Help with elderly care',
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

  const requestedInterview: InterviewRecord = {
    id: 'interview-1',
    bookingId: '01a1aa1c-5c3e-73ab-a73a-dd1d4a9d39b5',
    type: 'INTERVIEW',
    status: 'REQUESTED',
    requestedByKind: 'CUSTOMER',
    requestedByUserId: 'customer-user-1',
    preferredAt: new Date('2026-11-06T10:00:00.000Z'),
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
      lock: jest.fn(() => Promise.resolve({ ...baseMatchedBooking })),
      findById: jest.fn(() => Promise.resolve({ ...baseMatchedBooking })),
      update: jest.fn(() => Promise.resolve({ ...baseMatchedBooking })),
      addEvent: jest.fn(() => Promise.resolve({})),
      listEvents: jest.fn(() => Promise.resolve([])),
      list: jest.fn(() => Promise.resolve({ items: [{ ...baseMatchedBooking }], total: 1 })),
    };

    mockInterviews = {
      findOpen: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({ ...requestedInterview, status: 'CONFIRMED' })),
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
      namesByIds: jest.fn(() => Promise.resolve(new Map([['worker-profile-1', 'Ramesh K.']]))),
      requireRefById: jest.fn(() =>
        Promise.resolve({
          userId: 'worker-user-1',
          workerId: 'worker-profile-1',
        }),
      ),
      requireRefByUserId: jest.fn(() =>
        Promise.resolve({
          userId: 'worker-user-1',
          workerId: 'worker-profile-1',
        }),
      ),
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

    workerController = new WorkerBookingsController(bookingService, mockWorkers as never);
  });

  describe('Task 1: Booking Acceptance (accept & confirm-worker for worker)', () => {
    it('proves actionsFor(WORKER) includes accept and does not grant global confirm-worker', () => {
      const workerActions = actionsFor('WORKER');
      expect(workerActions).toContain('accept');
      expect(workerActions).not.toContain('confirm-worker');
    });

    it('worker calling confirm-worker on MATCHED booking without interview succeeds with 200 and sets workerRespondedAt', async () => {
      mockRepo.lock.mockResolvedValueOnce({ ...baseMatchedBooking });
      mockRepo.findById.mockResolvedValueOnce({
        ...baseMatchedBooking,
        workerRespondedAt: new Date(),
      });

      const res = await bookingService.act(
        baseMatchedBooking.id,
        'confirm-worker',
        {},
        workerActor,
      );

      expect(res).toBeDefined();
      expect(mockRepo.update).toHaveBeenCalledWith(
        baseMatchedBooking.id,
        expect.objectContaining({
          status: 'MATCHED',
          workerRespondedAt: expect.any(Date),
        }),
        expect.anything(),
      );
      expect(mockOutbox.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: NotificationEvent.WORKER_ACCEPTED,
          recipients: [baseMatchedBooking.customerUserId],
        }),
        expect.anything(),
      );
    });

    it('worker calling confirm-worker on MATCHED booking with REQUESTED interview confirms interview and moves booking to INTERVIEW_TRIAL_SCHEDULED', async () => {
      mockRepo.lock.mockResolvedValueOnce({ ...baseMatchedBooking });
      mockInterviews.findOpen.mockResolvedValueOnce({ ...requestedInterview });
      mockRepo.findById.mockResolvedValueOnce({
        ...baseMatchedBooking,
        status: 'INTERVIEW_TRIAL_SCHEDULED',
        scheduleType: 'INTERVIEW',
        scheduledAt: requestedInterview.preferredAt,
        workerRespondedAt: new Date(),
      });

      const res = await bookingService.act(
        baseMatchedBooking.id,
        'confirm-worker',
        {},
        workerActor,
      );

      expect(res).toBeDefined();
      expect(mockInterviews.update).toHaveBeenCalledWith(
        requestedInterview.id,
        {
          status: 'CONFIRMED',
          scheduledAt: requestedInterview.preferredAt,
        },
        expect.anything(),
      );
      expect(mockRepo.update).toHaveBeenCalledWith(
        baseMatchedBooking.id,
        expect.objectContaining({
          status: 'INTERVIEW_TRIAL_SCHEDULED',
          scheduleType: 'INTERVIEW',
          scheduledAt: requestedInterview.preferredAt,
          outcomeNote: null,
          workerRespondedAt: expect.any(Date),
        }),
        expect.anything(),
      );
      expect(mockOutbox.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: NotificationEvent.INTERVIEW_TRIAL_SCHEDULED,
        }),
        expect.anything(),
      );
      expect(mockOutbox.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          event: NotificationEvent.WORKER_ACCEPTED,
        }),
        expect.anything(),
      );
    });

    it('worker calling accept on MATCHED booking with REQUESTED interview confirms interview and moves booking to INTERVIEW_TRIAL_SCHEDULED', async () => {
      mockRepo.lock.mockResolvedValueOnce({ ...baseMatchedBooking });
      mockInterviews.findOpen.mockResolvedValueOnce({ ...requestedInterview });
      mockRepo.findById.mockResolvedValueOnce({
        ...baseMatchedBooking,
        status: 'INTERVIEW_TRIAL_SCHEDULED',
        scheduleType: 'INTERVIEW',
        scheduledAt: requestedInterview.preferredAt,
        workerRespondedAt: new Date(),
      });

      const res = await bookingService.act(baseMatchedBooking.id, 'accept', {}, workerActor);

      expect(res).toBeDefined();
      expect(mockInterviews.update).toHaveBeenCalledWith(
        requestedInterview.id,
        {
          status: 'CONFIRMED',
          scheduledAt: requestedInterview.preferredAt,
        },
        expect.anything(),
      );
      expect(mockRepo.update).toHaveBeenCalledWith(
        baseMatchedBooking.id,
        expect.objectContaining({
          status: 'INTERVIEW_TRIAL_SCHEDULED',
          scheduleType: 'INTERVIEW',
          scheduledAt: requestedInterview.preferredAt,
          workerRespondedAt: expect.any(Date),
        }),
        expect.anything(),
      );
    });

    it('worker calling accept on direct MATCHED booking without interview sets workerRespondedAt and keeps status MATCHED', async () => {
      mockRepo.lock.mockResolvedValueOnce({ ...baseMatchedBooking });
      mockInterviews.findOpen.mockResolvedValueOnce(null);
      mockRepo.findById.mockResolvedValueOnce({
        ...baseMatchedBooking,
        workerRespondedAt: new Date(),
      });

      const res = await bookingService.act(baseMatchedBooking.id, 'accept', {}, workerActor);

      expect(res).toBeDefined();
      expect(mockInterviews.update).not.toHaveBeenCalled();
      expect(mockRepo.update).toHaveBeenCalledWith(
        baseMatchedBooking.id,
        expect.objectContaining({
          status: 'MATCHED',
          workerRespondedAt: expect.any(Date),
        }),
        expect.anything(),
      );
    });

    it('worker calling confirm-worker on a non-MATCHED booking rejects with 403 ACTION_NOT_ALLOWED', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseMatchedBooking,
        status: 'INTERVIEW_TRIAL_COMPLETED',
      });

      try {
        await bookingService.act(baseMatchedBooking.id, 'confirm-worker', {}, workerActor);
        fail('Expected ACTION_NOT_ALLOWED exception');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.ACTION_NOT_ALLOWED);
        expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(error.message).toBe('This action is not available to you');
      }
    });

    it('non-worker (customer) calling accept rejects with 403 ACTION_NOT_ALLOWED', async () => {
      try {
        await bookingService.act(baseMatchedBooking.id, 'accept', {}, customerActor);
        fail('Expected ACTION_NOT_ALLOWED exception');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.ACTION_NOT_ALLOWED);
        expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(error.message).toBe('This action is not available to you');
      }
    });

    it('worker calling invalid action rejects with 403 ACTION_NOT_ALLOWED', async () => {
      try {
        await bookingService.act(baseMatchedBooking.id, 'complete', {}, workerActor);
        fail('Expected ACTION_NOT_ALLOWED exception');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.ACTION_NOT_ALLOWED);
        expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(error.message).toBe('This action is not available to you');
      }
    });

    it('worker calling accept repeatedly on INTERVIEW_TRIAL_SCHEDULED is idempotent and returns booking ID', async () => {
      mockRepo.lock.mockResolvedValueOnce({
        ...baseMatchedBooking,
        status: 'INTERVIEW_TRIAL_SCHEDULED',
        workerRespondedAt: new Date(),
      });
      mockRepo.findById.mockResolvedValueOnce({
        ...baseMatchedBooking,
        status: 'INTERVIEW_TRIAL_SCHEDULED',
        workerRespondedAt: new Date(),
      });

      const res = await bookingService.act(baseMatchedBooking.id, 'accept', {}, workerActor);
      expect(res).toBeDefined();
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('WorkerBookingsController delegates confirm-worker and accept seamlessly', async () => {
      mockRepo.lock.mockResolvedValue({ ...baseMatchedBooking });
      mockRepo.findById.mockResolvedValue({
        ...baseMatchedBooking,
        workerRespondedAt: new Date(),
      });

      const user = {
        userId: 'worker-user-1',
        appType: 'WORKER',
        roles: ['WORKER'],
      };
      const view = await workerController.act(
        baseMatchedBooking.id,
        'confirm-worker',
        {},
        user as never,
      );

      expect(view).toBeDefined();
      expect(view.id).toBe(baseMatchedBooking.id);
    });
  });

  describe('Task 2: Interview Allowed Actions', () => {
    it('toInterviewView returns valid worker actions [accept, decline, propose] for REQUESTED status when actor is WORKER', () => {
      const view = toInterviewView(requestedInterview, 'WORKER');
      expect(view.allowedActions).toEqual(['accept', 'decline', 'propose']);
    });

    it('toInterviewView returns valid customer actions [reschedule, cancel] for REQUESTED status when actor is CUSTOMER', () => {
      const view = toInterviewView(requestedInterview, 'CUSTOMER');
      expect(view.allowedActions).toEqual(['reschedule', 'cancel']);
    });

    it('toInterviewView defaults to customer actions when actorKind is omitted for backwards compatibility', () => {
      const view = toInterviewView(requestedInterview);
      expect(view.allowedActions).toEqual(['reschedule', 'cancel']);
    });

    it('toInterviewView returns cancel for worker when CONFIRMED', () => {
      const confirmedInterview: InterviewRecord = {
        ...requestedInterview,
        status: 'CONFIRMED',
        scheduledAt: requestedInterview.preferredAt,
      };
      const view = toInterviewView(confirmedInterview, 'WORKER');
      expect(view.allowedActions).toEqual(['cancel']);
    });
  });

  describe('Task 3: WorkerBookingView openInterviewId Exposure', () => {
    it('opportunitiesForWorker exposes openInterviewId when an open interview exists', async () => {
      mockInterviews.findOpen.mockResolvedValueOnce(requestedInterview);

      const result = await bookingService.opportunitiesForWorker('worker-profile-1', {
        page: 1,
        limit: 20,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].openInterviewId).toBe(requestedInterview.id);
    });

    it('opportunitiesForWorker sets openInterviewId to null when no open interview exists', async () => {
      mockInterviews.findOpen.mockResolvedValueOnce(null);

      const result = await bookingService.opportunitiesForWorker('worker-profile-1', {
        page: 1,
        limit: 20,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].openInterviewId).toBeNull();
    });

    it('getForWorker exposes openInterviewId', async () => {
      mockInterviews.findOpen.mockResolvedValueOnce(requestedInterview);

      const view = await bookingService.getForWorker('worker-profile-1', baseMatchedBooking.id);

      expect(view.openInterviewId).toBe(requestedInterview.id);
    });
  });
});
