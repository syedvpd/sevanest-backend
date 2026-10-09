import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import { indiaToday, isRealDate } from '../../common/time/india';
import type { Prisma } from '../../generated/prisma/client';
import { toMinutes, toText } from '../availability/domain/time-windows';
import { ServiceAreasService } from '../availability/service-areas.service';
import { SearchService } from '../search/search.service';
import { ServiceCategoriesService } from '../service-categories/service-categories.service';
import { WorkersService } from '../workers/workers.service';
import { BookingLifecycleHooks } from './booking-hooks';
import {
  AdminBookingListQuery,
  AdminBookingView,
  BOOKING_ACTIONS,
  BookingAction,
  BookingActionDto,
  BookingDetailView,
  BookingListQuery,
  BookingStatusValue,
  BookingView,
  CreateBookingDto,
  TimelineEntry,
  WorkerBookingView,
} from './dto/booking.dto';
import { BookingEventRecord, BookingRecord, BookingRepository } from './booking.repository';

export const BookingErrorCode = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED',
  WORKER_NOT_ELIGIBLE: 'WORKER_NOT_ELIGIBLE',
  DUPLICATE_BOOKING: 'DUPLICATE_BOOKING',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
} as const;

export type ActorKindValue = 'CUSTOMER' | 'WORKER' | 'ADMIN' | 'SYSTEM';

/** Who is acting. `workerId` is the worker profile of a WORKER actor. */
export interface BookingActor {
  kind: ActorKindValue;
  userId: string | null;
  workerId?: string;
  roles?: string[];
}

interface Rule {
  from: BookingStatusValue[];
  to: BookingStatusValue;
  actors: ActorKindValue[];
}

/** FRD section 4 (PROPOSED, Q-05): each action is one permitted transition and the parties allowed to trigger it. */
const RULES: Record<BookingAction, Rule[]> = {
  match: [{ from: ['NEW_REQUEST'], to: 'MATCHED', actors: ['ADMIN'] }],
  schedule: [
    { from: ['MATCHED'], to: 'INTERVIEW_TRIAL_SCHEDULED', actors: ['CUSTOMER', 'WORKER', 'ADMIN'] },
  ],
  decline: [
    { from: ['MATCHED'], to: 'NEW_REQUEST', actors: ['WORKER', 'ADMIN'] },
    { from: ['INTERVIEW_TRIAL_SCHEDULED'], to: 'MATCHED', actors: ['WORKER', 'ADMIN'] },
  ],
  'reopen-matching': [
    {
      from: ['INTERVIEW_TRIAL_SCHEDULED', 'INTERVIEW_TRIAL_COMPLETED'],
      to: 'MATCHED',
      actors: ['CUSTOMER', 'ADMIN'],
    },
  ],
  'interview-complete': [
    {
      from: ['INTERVIEW_TRIAL_SCHEDULED'],
      to: 'INTERVIEW_TRIAL_COMPLETED',
      actors: ['CUSTOMER', 'ADMIN'],
    },
  ],
  'confirm-worker': [
    { from: ['INTERVIEW_TRIAL_COMPLETED'], to: 'PENDING_PAYMENT', actors: ['CUSTOMER', 'ADMIN'] },
  ],
  start: [{ from: ['CONFIRMED'], to: 'ACTIVE', actors: ['CUSTOMER', 'WORKER', 'ADMIN'] }],
  complete: [{ from: ['ACTIVE'], to: 'COMPLETED', actors: ['CUSTOMER', 'ADMIN'] }],
  cancel: [
    {
      from: [
        'NEW_REQUEST',
        'MATCHED',
        'INTERVIEW_TRIAL_SCHEDULED',
        'INTERVIEW_TRIAL_COMPLETED',
        'PENDING_PAYMENT',
        'CONFIRMED',
        'REPLACEMENT_REQUESTED',
      ],
      to: 'CANCELLED',
      actors: ['CUSTOMER', 'ADMIN'],
    },
  ],
};

/** Actions an actor kind may attempt at all (the rest answer 403 before the state is even looked at). */
export function actionsFor(kind: ActorKindValue): BookingAction[] {
  return BOOKING_ACTIONS.filter((a) => RULES[a].some((r) => r.actors.includes(kind)));
}

/**
 * Booking lifecycle (SRS 3.5, FRD FM-06/FM-08, state model section 4). Owns the booking tables and the state machine; every
 * change locks the row, records the timeline entry, writes the audit record and the notification outbox event in ONE
 * transaction. Payment, Notifications, Attendance and Replacement act on bookings only through the contract methods below.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly repository: BookingRepository,
    private readonly categories: ServiceCategoriesService,
    private readonly areas: ServiceAreasService,
    private readonly workers: WorkersService,
    private readonly search: SearchService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly hooks: BookingLifecycleHooks,
  ) {}

  // --- customer ---------------------------------------------------------------------------------------------

  async create(
    customerUserId: string,
    dto: CreateBookingDto,
    idempotencyKey?: string,
  ): Promise<{ booking: BookingDetailView; created: boolean }> {
    const fromMinute = toMinutes(dto.availableFrom);
    const toMinute = toMinutes(dto.availableTo);
    if (fromMinute >= toMinute) {
      throw this.invalid('availableFrom', 'availableFrom must be earlier than availableTo');
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          dto.category,
          dto.areaId,
          dto.engagement,
          fromMinute,
          toMinute,
          dto.workerId ?? null,
        ]),
      )
      .digest('hex');
    if (idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(customerUserId, idempotencyKey);
      if (existing) {
        return { booking: await this.replay(existing, requestHash), created: false };
      }
    }
    const [category, area] = await Promise.all([
      this.categories.requireEnabledByCode(dto.category),
      this.areas.requireEnabled(dto.areaId),
    ]);
    if (dto.workerId) {
      await this.assertEligible(dto.workerId, {
        categoryId: category.id,
        areaId: area.id,
        engagement: dto.engagement,
        fromMinute,
        toMinute,
      });
    }
    try {
      const id = await this.repository.transaction(async (tx) => {
        const created = await this.repository.create(
          {
            customerUserId,
            categoryId: category.id,
            areaId: area.id,
            engagement: dto.engagement,
            fromMinute,
            toMinute,
            idempotencyKey: idempotencyKey ?? null,
            requestHash: idempotencyKey ? requestHash : null,
          },
          tx,
        );
        await this.repository.addEvent(
          {
            bookingId: created.id,
            fromStatus: null,
            toStatus: 'NEW_REQUEST',
            actorUserId: customerUserId,
            actorKind: 'CUSTOMER',
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'booking.create',
            entityType: 'booking',
            entityId: created.id,
            actorId: customerUserId,
            metadata: { category: category.code, areaId: area.id, engagement: dto.engagement },
          },
          tx,
        );
        if (dto.workerId) {
          await this.assign(created, dto.workerId, { kind: 'SYSTEM', userId: null }, tx);
        }
        return created.id;
      });
      return {
        booking: await this.detail((await this.repository.findById(id))!, false),
        created: true,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (idempotencyKey) {
          const existing = await this.repository.findByIdempotencyKey(
            customerUserId,
            idempotencyKey,
          );
          if (existing) {
            return { booking: await this.replay(existing, requestHash), created: false };
          }
        }
        throw new DomainException(
          BookingErrorCode.DUPLICATE_BOOKING,
          'You already have an open booking with this worker for this service',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async listMine(customerUserId: string, query: BookingListQuery): Promise<Page<BookingView>> {
    const { items, total } = await this.repository.list(
      { customerUserId, status: query.status },
      skipFor(query),
      query.limit,
    );
    return {
      data: await this.views(items),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async getMine(customerUserId: string, bookingId: string): Promise<BookingDetailView> {
    const booking = await this.repository.findById(bookingId);
    if (!booking || booking.customerUserId !== customerUserId) {
      throw this.notFound();
    }
    return this.detail(booking, false);
  }

  // --- worker ------------------------------------------------------------------------------------------------

  async listForWorker(workerId: string, query: BookingListQuery): Promise<Page<WorkerBookingView>> {
    const { items, total } = await this.repository.list(
      { workerId, status: query.status },
      skipFor(query),
      query.limit,
    );
    const views = await this.views(items);
    return {
      data: views.map((view) => this.workerView(view)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async getForWorker(workerId: string, bookingId: string): Promise<WorkerBookingView> {
    const booking = await this.repository.findById(bookingId);
    if (!booking || booking.workerId !== workerId) {
      throw this.notFound();
    }
    return this.workerView((await this.views([booking]))[0]);
  }

  // --- admin -------------------------------------------------------------------------------------------------

  async adminList(query: AdminBookingListQuery): Promise<Page<BookingView>> {
    const { items, total } = await this.repository.list(
      { customerUserId: query.customerUserId, workerId: query.workerId, status: query.status },
      skipFor(query),
      query.limit,
    );
    return {
      data: await this.views(items),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(bookingId: string): Promise<AdminBookingView> {
    const booking = await this.repository.findById(bookingId);
    if (!booking) throw this.notFound();
    const detail = await this.detail(booking, true);
    return {
      ...detail,
      customerUserId: booking.customerUserId,
      cancelledByUserId: booking.cancelledByUserId,
    };
  }

  // --- actions (all parties) ---------------------------------------------------------------------------------

  /**
   * Performs one lifecycle action. Ownership is checked inside the transaction after the row is locked, so a concurrent
   * reassignment cannot let a former worker act. A repeated action whose result already holds changes nothing.
   */
  async act(
    bookingId: string,
    action: BookingAction,
    dto: BookingActionDto,
    actor: BookingActor,
  ): Promise<BookingDetailView> {
    if (!actionsFor(actor.kind).includes(action)) {
      throw new DomainException(
        BookingErrorCode.ACTION_NOT_ALLOWED,
        'This action is not available to you',
        HttpStatus.FORBIDDEN,
      );
    }
    const prepared = this.prepare(action, dto);
    const result = await this.repository.transaction(async (tx) => {
      const booking = await this.repository.lock(bookingId, tx);
      if (!booking || !this.owns(booking, actor)) {
        throw this.notFound();
      }
      const rule = RULES[action].find(
        (r) => r.actors.includes(actor.kind) && r.from.includes(booking.status),
      );
      if (!rule) {
        const any = RULES[action].find((r) => r.actors.includes(actor.kind))!;
        if (booking.status === any.to && this.isRepeat(action, booking, dto)) {
          return booking.id;
        }
        throw new DomainException(
          BookingErrorCode.INVALID_TRANSITION,
          `A booking that is ${booking.status} cannot ${action}`,
          HttpStatus.CONFLICT,
        );
      }
      await this.apply(booking, action, rule, dto, prepared, actor, tx);
      return booking.id;
    });
    const fresh = (await this.repository.findById(result))!;
    return this.detail(fresh, actor.kind === 'ADMIN');
  }

  // --- contract for other modules (Payment, Attendance, Replacement) -----------------------------------------

  async getSummary(bookingId: string): Promise<{
    id: string;
    status: BookingStatusValue;
    customerUserId: string;
    workerId: string | null;
    startDate: string | null;
  }> {
    const booking = await this.repository.findById(bookingId);
    if (!booking) throw this.notFound();
    return {
      id: booking.id,
      status: booking.status,
      customerUserId: booking.customerUserId,
      workerId: booking.workerId,
      startDate: booking.startDate,
    };
  }

  /** The requirement of a booking in the vocabulary Matching understands. */
  async getRequirement(bookingId: string): Promise<{
    customerUserId: string;
    workerId: string | null;
    category: string;
    areaId: string;
    engagement: BookingRecord['engagement'];
    availableFrom: string;
    availableTo: string;
  }> {
    const booking = await this.repository.findById(bookingId);
    if (!booking) throw this.notFound();
    const [category] = await this.categories.findByIds([booking.categoryId]);
    return {
      customerUserId: booking.customerUserId,
      workerId: booking.workerId,
      category: category.code,
      areaId: booking.areaId,
      engagement: booking.engagement,
      availableFrom: toText(booking.fromMinute),
      availableTo: toText(booking.toMinute),
    };
  }

  /** Payment succeeded: PENDING_PAYMENT to CONFIRMED in the payment's own transaction. False if the booking moved on. */
  async applyPaymentSucceeded(bookingId: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const booking = await this.repository.lock(bookingId, tx);
    if (!booking || booking.status !== 'PENDING_PAYMENT') return false;
    await this.move(booking, { status: 'CONFIRMED' }, { kind: 'SYSTEM', userId: null }, tx, {
      action: 'booking.confirm',
      note: 'payment received',
    });
    await this.notifyBoth(
      booking,
      NotificationEvent.BOOKING_CONFIRMED,
      { bookingId: booking.id, startDate: booking.startDate ?? '' },
      tx,
    );
    return true;
  }

  /** Replacement requested (customer). The booking must be theirs and ACTIVE. */
  async requestReplacement(
    bookingId: string,
    customerUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const booking = await this.repository.lock(bookingId, tx);
    if (!booking || booking.customerUserId !== customerUserId) throw this.notFound();
    this.requireStatus(booking, 'ACTIVE');
    await this.move(
      booking,
      { status: 'REPLACEMENT_REQUESTED' },
      this.customerActor(customerUserId),
      tx,
      {
        action: 'booking.replacement_requested',
      },
    );
  }

  /** Replacement rejected or withdrawn: REPLACEMENT_REQUESTED back to ACTIVE. */
  async restoreActive(
    bookingId: string,
    actor: BookingActor,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const booking = await this.repository.lock(bookingId, tx);
    if (!booking) throw this.notFound();
    this.requireStatus(booking, 'REPLACEMENT_REQUESTED');
    await this.move(booking, { status: 'ACTIVE' }, actor, tx, {
      action: 'booking.replacement_closed',
    });
  }

  /**
   * Replacement confirmed: creates the replacement booking (same requirement, the chosen worker, MATCHED) and closes the
   * old one as REPLACED, linked. Returns the new booking id.
   */
  async completeReplacement(
    bookingId: string,
    newWorkerId: string,
    actor: BookingActor,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const old = await this.repository.lock(bookingId, tx);
    if (!old) throw this.notFound();
    this.requireStatus(old, 'REPLACEMENT_REQUESTED');
    await this.assertEligible(newWorkerId, old);
    const created = await this.repository.create(
      {
        customerUserId: old.customerUserId,
        categoryId: old.categoryId,
        areaId: old.areaId,
        engagement: old.engagement,
        fromMinute: old.fromMinute,
        toMinute: old.toMinute,
        replacesBookingId: old.id,
      },
      tx,
    );
    await this.repository.addEvent(
      {
        bookingId: created.id,
        fromStatus: null,
        toStatus: 'NEW_REQUEST',
        actorUserId: actor.userId,
        actorKind: actor.kind,
        note: 'replacement booking',
      },
      tx,
    );
    await this.assign(created, newWorkerId, actor, tx);
    await this.move(old, { status: 'REPLACED' }, actor, tx, {
      action: 'booking.replaced',
      note: `replaced by ${created.id}`,
    });
    return created.id;
  }

  // --- internals ---------------------------------------------------------------------------------------------

  private async apply(
    booking: BookingRecord,
    action: BookingAction,
    rule: Rule,
    dto: BookingActionDto,
    prepared: Prepared,
    actor: BookingActor,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const audit = `booking.${action}`;
    switch (action) {
      case 'match': {
        await this.assertEligible(dto.workerId!, booking);
        await this.assign(booking, dto.workerId!, actor, tx, audit);
        return;
      }
      case 'schedule': {
        await this.move(
          booking,
          { status: rule.to, scheduleType: dto.scheduleType, scheduledAt: prepared.scheduledAt },
          actor,
          tx,
          { action: audit },
        );
        await this.notifyBoth(
          booking,
          NotificationEvent.INTERVIEW_TRIAL_SCHEDULED,
          {
            bookingId: booking.id,
            scheduleType: dto.scheduleType!,
            scheduledAt: prepared.scheduledAt!.toISOString(),
          },
          tx,
        );
        return;
      }
      case 'decline': {
        const toNew = rule.to === 'NEW_REQUEST';
        await this.move(
          booking,
          toNew
            ? { status: rule.to, workerId: null }
            : { status: rule.to, scheduleType: null, scheduledAt: null },
          actor,
          tx,
          { action: audit },
        );
        return;
      }
      case 'reopen-matching': {
        await this.move(
          booking,
          { status: rule.to, scheduleType: null, scheduledAt: null, outcomeNote: null },
          actor,
          tx,
          { action: audit },
        );
        return;
      }
      case 'interview-complete': {
        await this.move(booking, { status: rule.to, outcomeNote: dto.outcomeNote }, actor, tx, {
          action: audit,
          note: dto.outcomeNote,
        });
        return;
      }
      case 'confirm-worker': {
        await this.assertEligible(booking.workerId!, booking);
        await this.move(booking, { status: rule.to, startDate: dto.startDate }, actor, tx, {
          action: audit,
        });
        return;
      }
      case 'cancel': {
        await this.move(
          booking,
          {
            status: rule.to,
            cancelReason: dto.reason,
            cancelledAt: new Date(),
            cancelledByUserId: actor.userId,
          },
          actor,
          tx,
          { action: audit, note: dto.reason },
        );
        await this.hooks.cancelled(booking.id, actor, tx);
        return;
      }
      default:
        await this.move(booking, { status: rule.to }, actor, tx, { action: audit });
    }
  }

  /** Puts a worker on a NEW_REQUEST booking: MATCHED, with the opportunity notification for the worker. */
  private async assign(
    booking: BookingRecord,
    workerId: string,
    actor: BookingActor,
    tx: Prisma.TransactionClient,
    auditAction = 'booking.match',
  ): Promise<void> {
    await this.move(booking, { status: 'MATCHED', workerId }, actor, tx, { action: auditAction });
    const worker = await this.workers.requireRefById(workerId);
    const [category] = await this.categories.findByIds([booking.categoryId]);
    const [area] = await this.areas.findByIds([booking.areaId]);
    await this.outbox.notify(
      {
        event: NotificationEvent.JOB_OPPORTUNITY,
        recipients: [worker.userId],
        params: { bookingId: booking.id, category: category.name, area: area.name },
      },
      tx,
    );
  }

  private async move(
    booking: BookingRecord,
    change: Parameters<BookingRepository['update']>[1],
    actor: BookingActor,
    tx: Prisma.TransactionClient,
    info: { action: string; note?: string },
  ): Promise<void> {
    await this.repository.update(booking.id, change, tx);
    await this.repository.addEvent(
      {
        bookingId: booking.id,
        fromStatus: booking.status,
        toStatus: change.status,
        actorUserId: actor.userId,
        actorKind: actor.kind,
        note: info.note ?? null,
      },
      tx,
    );
    await this.audit.record(
      {
        action: info.action,
        entityType: 'booking',
        entityId: booking.id,
        actorId: actor.userId,
        actorRole: actor.roles?.join(',') || actor.kind,
        // Free-text notes stay in the timeline; the audit log keeps the state change only.
        metadata: { from: booking.status, to: change.status },
      },
      tx,
    );
  }

  private async notifyBoth(
    booking: BookingRecord,
    event: (typeof NotificationEvent)[keyof typeof NotificationEvent],
    params: Record<string, string>,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const recipients = [booking.customerUserId];
    if (booking.workerId) {
      recipients.push((await this.workers.requireRefById(booking.workerId)).userId);
    }
    await this.outbox.notify({ event, recipients, params }, tx);
  }

  private owns(booking: BookingRecord, actor: BookingActor): boolean {
    switch (actor.kind) {
      case 'CUSTOMER':
        return booking.customerUserId === actor.userId;
      case 'WORKER':
        return booking.workerId !== null && booking.workerId === actor.workerId;
      default:
        return true;
    }
  }

  private prepare(action: BookingAction, dto: BookingActionDto): Prepared {
    const missing = (field: string): DomainException =>
      this.invalid(field, `${field} is required to ${action}`);
    switch (action) {
      case 'match':
        if (!dto.workerId) throw missing('workerId');
        return {};
      case 'schedule': {
        if (!dto.scheduleType) throw missing('scheduleType');
        if (!dto.scheduledAt) throw missing('scheduledAt');
        const scheduledAt = new Date(dto.scheduledAt);
        if (scheduledAt.getTime() <= Date.now()) {
          throw this.invalid('scheduledAt', 'scheduledAt must be in the future');
        }
        return { scheduledAt };
      }
      case 'interview-complete':
        if (!dto.outcomeNote) throw missing('outcomeNote');
        return {};
      case 'confirm-worker':
        if (!dto.startDate) throw missing('startDate');
        if (!isRealDate(dto.startDate))
          throw this.invalid('startDate', 'startDate is not a real date');
        if (dto.startDate < indiaToday()) {
          throw this.invalid('startDate', 'startDate must be today or later');
        }
        return {};
      case 'cancel':
        if (!dto.reason) throw missing('reason');
        return {};
      default:
        return {};
    }
  }

  /** Is this call a repeat of the action that already produced the current state? Then it is a harmless no-op. */
  private isRepeat(action: BookingAction, booking: BookingRecord, dto: BookingActionDto): boolean {
    switch (action) {
      case 'match':
        return dto.workerId === booking.workerId;
      case 'schedule':
        return (
          dto.scheduleType === booking.scheduleType &&
          !!dto.scheduledAt &&
          new Date(dto.scheduledAt).getTime() === booking.scheduledAt?.getTime()
        );
      case 'confirm-worker':
        return dto.startDate === booking.startDate;
      case 'decline':
      case 'reopen-matching':
        // These move to a state other actions also pass through; repeating them cannot be told apart from a stale call.
        return false;
      default:
        return true;
    }
  }

  private async assertEligible(
    workerId: string,
    requirement: {
      categoryId: string;
      areaId: string;
      engagement: BookingRecord['engagement'];
      fromMinute: number;
      toMinute: number;
    },
  ): Promise<void> {
    const eligible = await this.search.isEligible({
      workerId,
      categoryId: requirement.categoryId,
      areaId: requirement.areaId,
      engagement: requirement.engagement,
      window: { fromMinute: requirement.fromMinute, toMinute: requirement.toMinute },
    });
    if (!eligible) {
      throw new DomainException(
        BookingErrorCode.WORKER_NOT_ELIGIBLE,
        'The worker is not available for this requirement',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'workerId', messages: ['the worker is not eligible for this booking'] }],
      );
    }
  }

  private requireStatus(booking: BookingRecord, status: BookingStatusValue): void {
    if (booking.status !== status) {
      throw new DomainException(
        BookingErrorCode.INVALID_TRANSITION,
        `A booking that is ${booking.status} cannot do that`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private customerActor(userId: string): BookingActor {
    return { kind: 'CUSTOMER', userId };
  }

  private async replay(existing: BookingRecord, requestHash: string): Promise<BookingDetailView> {
    if (existing.requestHash !== requestHash) {
      throw new DomainException(
        BookingErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different request',
        HttpStatus.CONFLICT,
      );
    }
    return this.detail(existing, false);
  }

  private async views(bookings: BookingRecord[]): Promise<BookingView[]> {
    const [categories, areas] = await Promise.all([
      this.categories.findByIds([...new Set(bookings.map((b) => b.categoryId))]),
      this.areas.findByIds([...new Set(bookings.map((b) => b.areaId))]),
    ]);
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const areaById = new Map(areas.map((a) => [a.id, a]));
    return bookings.map((b) => {
      const category = categoryById.get(b.categoryId)!;
      const area = areaById.get(b.areaId)!;
      return {
        id: b.id,
        status: b.status,
        category: { code: category.code, name: category.name },
        area: { id: area.id, name: area.name, city: area.city },
        engagement: b.engagement,
        availableFrom: toText(b.fromMinute),
        availableTo: toText(b.toMinute),
        workerId: b.workerId,
        scheduleType: b.scheduleType,
        scheduledAt: b.scheduledAt,
        outcomeNote: b.outcomeNote,
        startDate: b.startDate,
        cancelReason: b.cancelReason,
        replacesBookingId: b.replacesBookingId,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      };
    });
  }

  private async detail(booking: BookingRecord, forAdmin: boolean): Promise<BookingDetailView> {
    const [view] = await this.views([booking]);
    const events = await this.repository.listEvents(booking.id);
    return { ...view, timeline: events.map((e) => this.timelineEntry(e, forAdmin)) };
  }

  private timelineEntry(event: BookingEventRecord, forAdmin: boolean): TimelineEntry {
    return {
      from: event.fromStatus,
      to: event.toStatus,
      by: event.actorKind,
      // Staff notes (cancellation reasons, interview outcomes) are part of the customer's own booking history.
      note: event.note,
      at: event.createdAt,
      ...(forAdmin ? { actorUserId: event.actorUserId } : {}),
    };
  }

  private workerView(view: BookingView): WorkerBookingView {
    return {
      id: view.id,
      status: view.status,
      category: view.category,
      area: view.area,
      engagement: view.engagement,
      availableFrom: view.availableFrom,
      availableTo: view.availableTo,
      scheduleType: view.scheduleType,
      scheduledAt: view.scheduledAt,
      startDate: view.startDate,
      updatedAt: view.updatedAt,
    };
  }

  private notFound(): DomainException {
    return new DomainException(
      BookingErrorCode.BOOKING_NOT_FOUND,
      'Booking not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private invalid(field: string, message: string): DomainException {
    return new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field, messages: [message] }],
    );
  }
}

interface Prepared {
  scheduledAt?: Date;
}
