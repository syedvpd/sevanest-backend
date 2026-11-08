import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { BookingErrorCode, BookingService } from './booking.service';
import type { BookingRecord } from './booking.repository';
import type { FindAnotherWorkerDto } from './dto/booking.dto';

describe('BookingService Find Another Worker', () => {
  const originalId = 'original-booking';
  const successorId = 'successor-booking';
  const tx = {};
  const original = {
    id: originalId,
    customerUserId: 'customer-user',
    categoryId: 'category',
    areaId: 'area',
    engagement: 'MONTHLY',
    fromMinute: 540,
    toMinute: 1020,
    workerId: 'former-worker',
    status: 'INTERVIEW_TRIAL_COMPLETED',
    scheduleType: 'INTERVIEW',
    scheduledAt: new Date('2026-11-07T10:00:00.000Z'),
    startDate: null,
    requestedStartDate: '2026-11-08',
    budgetMinMinor: 50000,
    budgetMaxMinor: 80000,
    budgetPeriod: 'MONTHLY',
    requirementNote: 'Care support',
    workerRespondedAt: null,
    respondBy: null,
    proposedSlotAt: null,
    proposedSlotNote: null,
    addressId: 'address',
    outcomeNote: 'Completed trial',
    cancelReason: null,
    cancelledAt: null,
    cancelledByUserId: null,
    replacesBookingId: null,
    idempotencyKey: null,
    requestHash: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-07T00:00:00.000Z'),
  } as BookingRecord;
  const successor = {
    ...original,
    id: successorId,
    workerId: null,
    status: 'NEW_REQUEST',
    scheduleType: null,
    scheduledAt: null,
    outcomeNote: null,
    replacesBookingId: originalId,
  } as BookingRecord;
  const request = {
    id: 'request-id',
    originalBookingId: originalId,
    successorBookingId: successorId,
    requestedByUserId: 'customer-user',
    reasonCode: 'ATTENDANCE',
    reason: 'Attendance or punctuality',
    notes: 'Late twice',
    createdAt: new Date('2026-11-08T00:00:00.000Z'),
  };

  let service: BookingService;
  let repository: Record<string, jest.Mock>;
  let alerts: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let outbox: Record<string, jest.Mock>;
  let interviews: Record<string, jest.Mock>;
  let currentOriginal: BookingRecord;

  beforeEach(() => {
    currentOriginal = original;
    repository = {
      transaction: jest.fn((callback: (client: unknown) => Promise<unknown>) => callback(tx)),
      lock: jest.fn(() => Promise.resolve(currentOriginal)),
      findById: jest.fn((id: string) =>
        Promise.resolve(id === originalId ? currentOriginal : successor),
      ),
      findSuccessor: jest.fn().mockResolvedValue(null),
      lockReplacementReasonSetting: jest
        .fn()
        .mockResolvedValue({ label: 'Attendance or punctuality', isEnabled: true }),
      create: jest.fn().mockResolvedValue(successor),
      createFindAnotherWorkerRequest: jest.fn().mockResolvedValue(request),
      update: jest.fn((_id: string, change: Partial<BookingRecord>) => {
        currentOriginal = { ...currentOriginal, ...change };
        return Promise.resolve(undefined);
      }),
      addEvent: jest.fn().mockResolvedValue(undefined),
    };
    alerts = {
      raise: jest.fn().mockResolvedValue(undefined),
      autoResolve: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    outbox = { notify: jest.fn().mockResolvedValue(undefined) };
    interviews = { cancelOpen: jest.fn().mockResolvedValue(undefined) };
    service = new BookingService(
      repository as never,
      {} as never,
      {} as never,
      { requireRefById: jest.fn().mockResolvedValue({ userId: 'former-worker-user' }) } as never,
      {} as never,
      audit as never,
      outbox as never,
      {} as never,
      {} as never,
      {} as never,
      alerts as never,
      {} as never,
      interviews as never,
    );
  });

  it('creates an unassigned successor and closes the original atomically while retaining its worker', async () => {
    const result = await service.reopenMatching(
      originalId,
      { reasonCode: 'ATTENDANCE', notes: 'Late twice' },
      {
        kind: 'CUSTOMER',
        userId: 'customer-user',
      },
    );

    expect(result).toMatchObject({
      request: {
        reasonCode: 'ATTENDANCE',
        reason: 'Attendance or punctuality',
        notes: 'Late twice',
      },
      originalBooking: { id: originalId, status: 'REPLACED', workerId: 'former-worker' },
      successorBooking: {
        id: successorId,
        status: 'NEW_REQUEST',
        workerId: null,
        replacesBookingId: originalId,
      },
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'NEW_REQUEST',
        workerId: null,
        replacesBookingId: originalId,
      }),
      tx,
    );
    expect(repository.update).toHaveBeenCalledWith(
      originalId,
      { status: 'REPLACED', replacementBeforeStart: true },
      tx,
    );
    expect(repository.createFindAnotherWorkerRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'ATTENDANCE', notes: 'Late twice' }),
      tx,
    );
    expect(interviews.cancelOpen).toHaveBeenCalledWith(originalId, 'booking moved to REPLACED', tx);
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: successorId, type: 'BOOKING_NEEDS_MATCH' }),
      tx,
    );
    expect(outbox.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: NotificationEvent.FIND_ANOTHER_WORKER,
        recipients: ['former-worker-user'],
      }),
      tx,
    );
    expect(repository.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a second successor before creating or changing either booking', async () => {
    repository.findSuccessor.mockResolvedValue(successor);

    const error = await service
      .reopenMatching(
        originalId,
        { reasonCode: 'ATTENDANCE' },
        { kind: 'CUSTOMER', userId: 'customer-user' },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(BookingErrorCode.SUCCESSOR_ALREADY_EXISTS);
    expect((error as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);

    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('requires the customer to submit the completed-interview reason', async () => {
    const error = await service
      .reopenMatching(
        originalId,
        { reasonCode: 'ATTENDANCE' },
        { kind: 'ADMIN', userId: 'admin-user', roles: ['booking.manage'] },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(BookingErrorCode.ACTION_NOT_ALLOWED);
    expect((error as DomainException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('requires a reason and a description for OTHER before creating a successor', async () => {
    for (const dto of [{}, { reasonCode: 'OTHER' }] as FindAnotherWorkerDto[]) {
      const error = await service
        .reopenMatching(originalId, dto, { kind: 'CUSTOMER', userId: 'customer-user' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects a reason disabled by Admin before creating a successor', async () => {
    repository.lockReplacementReasonSetting.mockResolvedValue({
      label: 'Attendance',
      isEnabled: false,
    });
    const error = await service
      .reopenMatching(
        originalId,
        { reasonCode: 'ATTENDANCE' },
        { kind: 'CUSTOMER', userId: 'customer-user' },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(BookingErrorCode.REPLACEMENT_REASON_DISABLED);
    expect((error as DomainException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(repository.create).not.toHaveBeenCalled();
  });
});
