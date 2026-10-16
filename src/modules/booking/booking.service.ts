import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, PageQueryDto, skipFor } from '../../common/pagination/pagination';
import { createdRange, indiaToday, isRealDate } from '../../common/time/india';
import type { Prisma } from '../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { toMinutes, toText } from '../availability/domain/time-windows';
import { ServiceAreasService } from '../availability/service-areas.service';
import { SearchService } from '../search/search.service';
import { ServiceCategoriesService } from '../service-categories/service-categories.service';
import { AlertsService } from '../alerts/alerts.service';
import { CustomersService } from '../customers/customers.service';
import { LegalService } from '../legal/legal.service';
import { PermissionCode } from '../users/rbac.constants';
import { WorkersService } from '../workers/workers.service';
import { evaluateRatingEligibility } from '../../common/rating/rating-eligibility';
import { BookingLifecycleHooks } from './booking-hooks';
import {
  AdminBookingListQuery,
  AdminBookingView,
  BOOKING_ACTIONS,
  BookingAction,
  BookingActionDto,
  BookingDetailView,
  BookingFilterQuery,
  BookingHistoryQuery,
  CUSTOMER_ALLOWED_ACTIONS,
  CustomerAllowedAction,
  CustomerBookingDetailView,
  CustomerBookingView,
  HISTORY_STATUSES,
  RebookDto,
  WorkerDisplayView,
  ChainEntryView,
  ProposeSlotDto,
  BookingStatusValue,
  BookingView,
  CreateBookingDto,
  TimelineEntry,
  WorkerBookingView,
} from './dto/booking.dto';
import {
  BookingEventRecord,
  BookingFilter,
  BookingRecord,
  BookingRepository,
  WORKER_VISIBLE_STATUSES,
} from './booking.repository';
import { InterviewRepository } from './interview.repository';

export const BookingErrorCode = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED',
  WORKER_NOT_ELIGIBLE: 'WORKER_NOT_ELIGIBLE',
  DUPLICATE_BOOKING: 'DUPLICATE_BOOKING',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
  OUTSIDE_SERVICE_AREA: 'OUTSIDE_SERVICE_AREA',
  START_TOO_EARLY: 'START_TOO_EARLY',
  NO_SLOT_PROPOSAL: 'NO_SLOT_PROPOSAL',
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
  REBOOK_NOT_ALLOWED: 'REBOOK_NOT_ALLOWED',
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
  accept: [{ from: ['MATCHED'], to: 'MATCHED', actors: ['WORKER', 'ADMIN'] }],
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

/** A worker moved the booking backwards (declined, or their interview was cancelled): the note is the worker's private reason. */
function workerSteppedBack(event: BookingEventRecord): boolean {
  return (
    event.actorKind === 'WORKER' &&
    event.fromStatus !== event.toStatus &&
    (event.toStatus === 'NEW_REQUEST' || event.toStatus === 'MATCHED')
  );
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
    private readonly customers: CustomersService,
    private readonly legal: LegalService,
    private readonly alerts: AlertsService,
    private readonly config: AppConfigService,
    private readonly interviews: InterviewRepository,
  ) {}

  private readonly logger = new Logger(BookingService.name);

  // --- customer ---------------------------------------------------------------------------------------------

  async create(
    customerUserId: string,
    dto: CreateBookingDto,
    idempotencyKey?: string,
    onBehalfOf?: { userId: string; roles: string[] },
  ): Promise<{ booking: BookingDetailView; created: boolean }> {
    const fromMinute = toMinutes(dto.availableFrom);
    const toMinute = toMinutes(dto.availableTo);
    if (fromMinute >= toMinute) {
      throw this.invalid('availableFrom', 'availableFrom must be earlier than availableTo');
    }
    await this.legal.assertAccepted(customerUserId);
    this.validateRequest(dto);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          dto.category,
          dto.areaId,
          dto.engagement,
          fromMinute,
          toMinute,
          dto.workerId ?? null,
          dto.addressId ?? null,
          dto.startDate ?? null,
          dto.budgetMinMinor ?? null,
          dto.budgetMaxMinor ?? null,
          dto.budgetPeriod ?? null,
          dto.requirementNote ?? null,
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
    await this.categories.assertEngagementOffered(category.id, dto.engagement);
    let addressId: string | null = null;
    if (dto.addressId) {
      const address = await this.customers.findActiveAddressForBooking(
        customerUserId,
        dto.addressId,
      );
      // Someone else's, removed and unknown addresses are indistinguishable.
      if (!address) {
        throw new DomainException(
          BookingErrorCode.ADDRESS_NOT_FOUND,
          'Address not found',
          HttpStatus.NOT_FOUND,
        );
      }
      if (address.city.trim().toLowerCase() !== area.city.trim().toLowerCase()) {
        throw new DomainException(
          BookingErrorCode.OUTSIDE_SERVICE_AREA,
          'The address is outside the city of the selected service area',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: 'addressId', messages: ['the address is not in the service area city'] }],
        );
      }
      addressId = address.id;
    }
    if (dto.workerId) {
      await this.assertEligible(dto.workerId, {
        categoryId: category.id,
        areaId: area.id,
        engagement: dto.engagement,
        fromMinute,
        toMinute,
        customerUserId,
        startDate: dto.startDate,
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
            addressId,
            requestedStartDate: dto.startDate ?? null,
            budgetMinMinor: dto.budgetMinMinor ?? null,
            budgetMaxMinor: dto.budgetMaxMinor ?? null,
            budgetPeriod: dto.budgetPeriod ?? null,
            requirementNote: dto.requirementNote ?? null,
          },
          tx,
        );
        await this.repository.addEvent(
          {
            bookingId: created.id,
            fromStatus: null,
            toStatus: 'NEW_REQUEST',
            actorUserId: onBehalfOf?.userId ?? customerUserId,
            actorKind: onBehalfOf ? 'ADMIN' : 'CUSTOMER',
          },
          tx,
        );
        await this.audit.record(
          {
            action: onBehalfOf ? 'booking.admin_create' : 'booking.create',
            entityType: 'booking',
            entityId: created.id,
            actorId: onBehalfOf?.userId ?? customerUserId,
            actorRole: onBehalfOf?.roles.join(',') || null,
            metadata: {
              category: category.code,
              areaId: area.id,
              engagement: dto.engagement,
              ...(onBehalfOf ? { customerUserId } : {}),
            },
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

  /** Staff creating a booking for a customer who asked by phone: the same validation, a timeline entry and audit record naming the admin. */
  async createForCustomer(
    customerId: string,
    dto: CreateBookingDto,
    admin: { userId: string; roles: string[] },
    idempotencyKey?: string,
  ): Promise<{ booking: BookingDetailView; created: boolean }> {
    const customerUserId = await this.customers.activeUserIdOf(customerId);
    return this.create(customerUserId, dto, idempotencyKey, admin);
  }

  async listMine(
    customerUserId: string,
    query: BookingFilterQuery,
  ): Promise<Page<CustomerBookingView>> {
    const { items, total } = await this.repository.list(
      { customerUserId, ...this.filterOf(query) },
      skipFor(query),
      query.limit,
    );
    return {
      data: await this.customerViews(items),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** The customer's finished bookings (D-78): year, category and search filters, newest service first. */
  async historyMine(
    customerUserId: string,
    query: BookingHistoryQuery,
  ): Promise<Page<CustomerBookingView>> {
    const { items, total } = await this.repository.historyPage(
      customerUserId,
      {
        statuses: query.status ? [query.status] : [...HISTORY_STATUSES],
        year: query.year,
        categoryCode: query.category,
        search: query.search,
      },
      skipFor(query),
      query.limit,
    );
    return {
      data: await this.customerViews(items),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** Services and distinct workers for the history header (the spend comes from Payment, composed by the History module). */
  historyCountsMine(
    customerUserId: string,
    filter: { year?: number; category?: string },
  ): Promise<{ totalServices: number; distinctWorkers: number }> {
    return this.repository.historyCounts(customerUserId, {
      year: filter.year,
      categoryCode: filter.category,
    });
  }

  /**
   * "Hire again" (D-82): a NEW booking for the same worker with the same requirement, created through the normal creation path, so the
   * worker's eligibility, availability, service area, engagement, double-booking rule, the customer's terms acceptance and the
   * Idempotency-Key all apply again. Nothing of the old booking (payment, attendance, rating, timeline) is copied.
   */
  async rebook(
    customerUserId: string,
    dto: RebookDto,
    idempotencyKey?: string,
  ): Promise<{ booking: BookingDetailView; created: boolean }> {
    const source = await this.repository.findById(dto.bookingId);
    if (!source || source.customerUserId !== customerUserId) throw this.notFound();
    if (source.status !== 'COMPLETED' || source.workerId === null) {
      throw new DomainException(
        BookingErrorCode.REBOOK_NOT_ALLOWED,
        'Only a completed booking can be booked again',
        HttpStatus.CONFLICT,
      );
    }
    const [category] = await this.categories.findByIds([source.categoryId]);
    const keepAddress =
      source.addressId !== null &&
      (await this.customers.findActiveAddressForBooking(customerUserId, source.addressId)) !== null;
    const request: CreateBookingDto = {
      category: category.code,
      areaId: source.areaId,
      engagement: source.engagement,
      availableFrom: toText(source.fromMinute),
      availableTo: toText(source.toMinute),
      workerId: source.workerId,
      ...(keepAddress ? { addressId: source.addressId! } : {}),
      ...(dto.startDate ? { startDate: dto.startDate } : {}),
      ...(source.budgetMinMinor !== null ? { budgetMinMinor: source.budgetMinMinor } : {}),
      ...(source.budgetMaxMinor !== null ? { budgetMaxMinor: source.budgetMaxMinor } : {}),
      ...(source.budgetPeriod !== null ? { budgetPeriod: source.budgetPeriod } : {}),
      ...(source.requirementNote !== null ? { requirementNote: source.requirementNote } : {}),
    } as CreateBookingDto;
    return this.create(customerUserId, request, idempotencyKey);
  }

  /** The newest booking that is not finished (for the Home screen), or null. */
  async activeForCustomer(customerUserId: string): Promise<CustomerBookingView | null> {
    const { items } = await this.repository.list({ customerUserId, openOnly: true }, 0, 1);
    return (await this.customerViews(items))[0] ?? null;
  }

  async getMine(customerUserId: string, bookingId: string): Promise<CustomerBookingDetailView> {
    const booking = await this.repository.findById(bookingId);
    if (!booking || booking.customerUserId !== customerUserId) {
      throw this.notFound();
    }
    return (await this.detail(booking, false)) as CustomerBookingDetailView;
  }

  // --- worker ------------------------------------------------------------------------------------------------

  async listForWorker(
    workerId: string,
    query: BookingFilterQuery,
  ): Promise<Page<WorkerBookingView>> {
    const { items, total } = await this.repository.list(
      { workerId, ...this.filterOf(query) },
      skipFor(query),
      query.limit,
    );
    const views = await this.views(items);
    return {
      data: views.map((view) => this.workerView(view)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /**
   * The worker's opportunity feed (PRD 6.3): jobs matched to them that wait for their answer, newest first, with the answer deadline when
   * one is configured. Only the privacy-safe requirement summary is shown. A job leaves the feed when the worker answers, the customer
   * or staff change it, or it is cancelled.
   */
  // --- another interview/trial time (FRD schedule conflict: request another slot) -----------------------------

  /**
   * The matched worker cannot make the scheduled time and proposes another. The booking stays INTERVIEW_TRIAL_SCHEDULED at the original
   * time until the customer (or staff) accepts; one proposal is open at a time (a new one replaces it; the same time repeats safely).
   */
  async proposeSlot(
    workerId: string,
    bookingId: string,
    dto: ProposeSlotDto,
  ): Promise<WorkerBookingView> {
    const at = new Date(dto.proposedAt);
    if (at.getTime() <= Date.now()) {
      throw this.invalid('proposedAt', 'proposedAt must be in the future');
    }
    const workerUserId = (await this.workers.requireRefById(workerId)).userId;
    await this.repository.transaction(async (tx) => {
      const booking = await this.repository.lock(bookingId, tx);
      if (!booking || booking.workerId !== workerId) throw this.notFound();
      this.requireStatus(booking, 'INTERVIEW_TRIAL_SCHEDULED');
      if (booking.scheduledAt?.getTime() === at.getTime()) {
        throw this.invalid('proposedAt', 'that is already the scheduled time');
      }
      if (booking.proposedSlotAt?.getTime() === at.getTime()) return; // repeating changes nothing
      await this.repository.setSlotProposal(booking.id, { at, note: dto.note ?? null }, tx);
      await this.interviews.mirrorProposal(booking.id, { at, by: 'WORKER' }, null, tx);
      await this.repository.addEvent(
        {
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: booking.status,
          actorUserId: workerUserId,
          actorKind: 'WORKER',
          note: 'proposed another time',
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'booking.slot_proposed',
          entityType: 'booking',
          entityId: booking.id,
          actorId: workerUserId,
          metadata: { proposedAt: at.toISOString() },
        },
        tx,
      );
      await this.outbox.notify(
        {
          event: NotificationEvent.BOOKING_SLOT_PROPOSED,
          recipients: [booking.customerUserId],
          params: { bookingId: booking.id, proposedAt: at.toISOString() },
        },
        tx,
      );
    });
    return this.getForWorker(workerId, bookingId);
  }

  /** The customer (or staff) accepts the proposed time - it becomes the scheduled time - or keeps the original. */
  async answerSlotProposal(
    bookingId: string,
    accept: boolean,
    actor: BookingActor,
  ): Promise<BookingDetailView> {
    await this.repository.transaction(async (tx) => {
      const booking = await this.repository.lock(bookingId, tx);
      if (!booking) throw this.notFound();
      if (actor.kind === 'CUSTOMER' && booking.customerUserId !== actor.userId) {
        throw this.notFound();
      }
      this.requireStatus(booking, 'INTERVIEW_TRIAL_SCHEDULED');
      if (!booking.proposedSlotAt) {
        throw new DomainException(
          BookingErrorCode.NO_SLOT_PROPOSAL,
          'There is no proposed time to answer',
          HttpStatus.CONFLICT,
        );
      }
      if (accept) {
        if (booking.proposedSlotAt.getTime() <= Date.now()) {
          throw this.invalid('proposedAt', 'the proposed time has already passed');
        }
        await this.repository.setSchedule(booking.id, booking.proposedSlotAt, tx);
        await this.interviews.mirrorProposal(booking.id, null, booking.proposedSlotAt, tx);
      } else {
        await this.repository.setSlotProposal(booking.id, null, tx);
        await this.interviews.mirrorProposal(booking.id, null, null, tx);
      }
      await this.repository.addEvent(
        {
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: booking.status,
          actorUserId: actor.userId,
          actorKind: actor.kind,
          note: accept ? 'accepted the proposed time' : 'kept the original time',
        },
        tx,
      );
      await this.audit.record(
        {
          action: accept ? 'booking.slot_accepted' : 'booking.slot_rejected',
          entityType: 'booking',
          entityId: booking.id,
          actorId: actor.userId,
          actorRole: actor.roles?.join(',') || null,
        },
        tx,
      );
      if (booking.workerId) {
        await this.outbox.notify(
          {
            event: NotificationEvent.BOOKING_SLOT_ANSWERED,
            recipients: [(await this.workers.requireRefById(booking.workerId)).userId],
            params: { bookingId: booking.id, answer: accept ? 'ACCEPTED' : 'KEPT_ORIGINAL' },
          },
          tx,
        );
      }
    });
    return actor.kind === 'CUSTOMER'
      ? this.getMine(actor.userId!, bookingId)
      : this.adminGet(bookingId);
  }

  /**
   * The replacement chain a booking belongs to, oldest first (original booking, its replacement, the replacement of the replacement ...).
   * A customer sees only their own chain; workers are not exposed to it; staff also see the worker of each link.
   */
  async chain(
    bookingId: string,
    viewer: { kind: 'CUSTOMER'; userId: string } | { kind: 'ADMIN' },
  ): Promise<ChainEntryView[]> {
    const start = await this.repository.findById(bookingId);
    if (!start || (viewer.kind === 'CUSTOMER' && start.customerUserId !== viewer.userId)) {
      throw this.notFound();
    }
    const ids = await this.repository.replacementChain(bookingId);
    const records = await this.repository.findManyByIds(ids);
    const byId = new Map(records.map((r) => [r.id, r]));
    return ids.map((id, index) => {
      const r = byId.get(id)!;
      return {
        bookingId: r.id,
        position: index + 1,
        status: r.status,
        replacesBookingId: r.replacesBookingId,
        startDate: r.startDate,
        createdAt: r.createdAt,
        current: r.id === bookingId,
        ...(viewer.kind === 'ADMIN' ? { workerId: r.workerId } : {}),
      };
    });
  }

  async opportunitiesForWorker(
    workerId: string,
    query: PageQueryDto,
  ): Promise<Page<WorkerBookingView>> {
    const { items, total } = await this.repository.list(
      { workerId, status: 'MATCHED', awaitingWorkerResponse: true },
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

  private filterOf(query: BookingFilterQuery): Omit<BookingFilter, 'customerUserId' | 'workerId'> {
    return {
      status: query.status,
      categoryId: query.categoryId,
      areaId: query.areaId,
      engagement: query.engagement,
      ...createdRange(query.createdFrom, query.createdTo),
    };
  }

  async adminList(query: AdminBookingListQuery): Promise<Page<BookingView>> {
    const { items, total } = await this.repository.list(
      {
        customerUserId: query.customerUserId,
        workerId: query.workerId,
        ...this.filterOf(query),
      },
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

  /** For the interview / trial workflow (same module): one booking move with timeline, alerts and audit in the caller transaction. */
  async moveForInterview(
    booking: BookingRecord,
    change: Parameters<BookingRepository['update']>[1],
    actor: BookingActor,
    tx: Prisma.TransactionClient,
    info: { action: string; note?: string },
  ): Promise<void> {
    await this.move(booking, change, actor, tx, info);
  }

  // --- contract for other modules (Payment, Attendance, Replacement) -----------------------------------------

  async getSummary(bookingId: string): Promise<{
    id: string;
    status: BookingStatusValue;
    customerUserId: string;
    workerId: string | null;
    startDate: string | null;
    /** The booking's own time window, HH:mm. */
    availableFrom: string;
    availableTo: string;
  }> {
    const booking = await this.repository.findById(bookingId);
    if (!booking) throw this.notFound();
    return {
      id: booking.id,
      status: booking.status,
      customerUserId: booking.customerUserId,
      workerId: booking.workerId,
      startDate: booking.startDate,
      availableFrom: toText(booking.fromMinute),
      availableTo: toText(booking.toMinute),
    };
  }

  /** The requirement of a booking in the vocabulary Matching understands. */
  async getRequirement(bookingId: string): Promise<{
    customerUserId: string;
    workerId: string | null;
    status: BookingRecord['status'];
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
      status: booking.status,
      category: category.code,
      areaId: booking.areaId,
      engagement: booking.engagement,
      availableFrom: toText(booking.fromMinute),
      availableTo: toText(booking.toMinute),
    };
  }

  /** The booking's status inside the caller's transaction (the caller holds its row lock). null = no such booking. */
  async statusInTx(
    bookingId: string,
    tx: Prisma.TransactionClient,
  ): Promise<BookingStatusValue | null> {
    const booking = await this.repository.findById(bookingId, tx);
    return booking ? booking.status : null;
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

  /**
   * Takes the booking row lock for the rest of the transaction. Cross-module rule: when a workflow touches a booking AND its
   * own record (a replacement request), it locks the BOOKING first, exactly as a booking cancellation does before it calls
   * its hooks. Locking in the other order deadlocks when the two run together.
   */
  async lockBooking(bookingId: string, tx: Prisma.TransactionClient): Promise<void> {
    if (!(await this.repository.lock(bookingId, tx))) throw this.notFound();
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
    // The replacement works from today on, so the replacement worker must be free from today.
    await this.assertEligible(
      newWorkerId,
      { ...old, startDate: indiaToday(), excludeBookingId: old.id },
      { tx, lock: true },
    );
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
        await this.assertEligible(dto.workerId!, booking, { tx });
        await this.assign(booking, dto.workerId!, actor, tx, audit);
        return;
      }
      case 'accept': {
        if (booking.workerRespondedAt) return; // repeating changes nothing
        await this.move(booking, { status: rule.to, workerRespondedAt: new Date() }, actor, tx, {
          action: audit,
          note: 'worker accepted',
        });
        await this.outbox.notify(
          {
            event: NotificationEvent.WORKER_ACCEPTED,
            recipients: [booking.customerUserId],
            params: { bookingId: booking.id },
          },
          tx,
        );
        return;
      }
      case 'schedule': {
        await this.move(
          booking,
          {
            status: rule.to,
            scheduleType: dto.scheduleType,
            scheduledAt: prepared.scheduledAt,
            // A worker who proposes or confirms the slot has plainly responded to the opportunity.
            ...(actor.kind === 'WORKER' && !booking.workerRespondedAt
              ? { workerRespondedAt: new Date() }
              : {}),
          },
          actor,
          tx,
          { action: audit },
        );
        await this.interviews.confirmLegacy(
          booking.id,
          {
            type: dto.scheduleType!,
            at: prepared.scheduledAt!,
            kind: actor.kind,
            userId: actor.userId,
          },
          tx,
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
        await this.interviews.cancelOpen(booking.id, 'the worker declined the booking', tx);
        const toNew = rule.to === 'NEW_REQUEST';
        await this.move(
          booking,
          toNew
            ? { status: rule.to, workerId: null, workerRespondedAt: null, respondBy: null }
            : { status: rule.to, scheduleType: null, scheduledAt: null },
          actor,
          tx,
          { action: audit, note: dto.reason },
        );
        await this.outbox.notify(
          {
            event: NotificationEvent.WORKER_DECLINED,
            recipients: [booking.customerUserId],
            params: { bookingId: booking.id },
          },
          tx,
        );
        if (toNew) {
          // The request is back with staff and nobody is assigned: someone has to find another worker.
          await this.alerts.raise(
            {
              dedupeKey: `BOOKING_NEEDS_MATCH:${booking.id}`,
              type: 'BOOKING_NEEDS_MATCH',
              severity: 'WARNING',
              title: 'A booking has no worker after the worker declined',
              requiredPermission: PermissionCode.BOOKING_MANAGE,
              entityType: 'booking',
              entityId: booking.id,
            },
            tx,
          );
        }
        return;
      }
      case 'reopen-matching': {
        await this.interviews.cancelOpen(booking.id, 'matching was re-opened', tx);
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
        await this.interviews.completeLegacy(booking.id, dto.outcomeNote, tx);
        if (booking.workerId) {
          await this.outbox.notify(
            {
              event: NotificationEvent.INTERVIEW_OUTCOME,
              recipients: [(await this.workers.requireRefById(booking.workerId)).userId],
              params: { bookingId: booking.id },
            },
            tx,
          );
        }
        return;
      }
      case 'confirm-worker': {
        // Confirming gives the worker's time to this customer: under a per-worker lock, refuse it if the worker is already booked then.
        await this.assertEligible(
          booking.workerId!,
          { ...booking, startDate: dto.startDate, excludeBookingId: booking.id },
          { tx, lock: true },
        );
        await this.move(booking, { status: rule.to, startDate: dto.startDate }, actor, tx, {
          action: audit,
        });
        await this.outbox.notify(
          {
            event: NotificationEvent.BOOKING_PAYMENT_DUE,
            recipients: [booking.customerUserId],
            params: { bookingId: booking.id },
          },
          tx,
        );
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
        await this.hooks.cancelled(booking.id, actor, tx, booking.status);
        await this.notifyBoth(
          booking,
          NotificationEvent.BOOKING_CANCELLED,
          { bookingId: booking.id },
          tx,
        );
        return;
      }
      case 'start':
      case 'complete': {
        if (action === 'start') this.assertNotTooEarly(booking, actor);
        await this.move(booking, { status: rule.to }, actor, tx, { action: audit });
        await this.notifyBoth(
          booking,
          action === 'start'
            ? NotificationEvent.BOOKING_STARTED
            : NotificationEvent.BOOKING_COMPLETED,
          { bookingId: booking.id },
          tx,
        );
        return;
      }
      default:
        await this.move(booking, { status: rule.to }, actor, tx, { action: audit });
    }
  }

  /** Customers and workers cannot start the service before its agreed start date (less the configured tolerance); staff can. */
  private assertNotTooEarly(booking: BookingRecord, actor: BookingActor): void {
    if (actor.kind === 'ADMIN' || actor.kind === 'SYSTEM' || !booking.startDate) return;
    const earliest = new Date(`${booking.startDate}T00:00:00.000Z`);
    earliest.setUTCDate(earliest.getUTCDate() - this.config.ops.bookingStartEarlyDays);
    const today = indiaToday();
    if (today < earliest.toISOString().slice(0, 10)) {
      throw new DomainException(
        BookingErrorCode.START_TOO_EARLY,
        `The service cannot start before ${booking.startDate}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'startDate', messages: [`agreed start date is ${booking.startDate}`] }],
      );
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
    const hours = this.config.ops.workerResponseHours;
    await this.move(
      booking,
      {
        status: 'MATCHED',
        workerId,
        workerRespondedAt: null,
        respondBy: hours ? new Date(Date.now() + hours * 3_600_000) : null,
      },
      actor,
      tx,
      { action: auditAction },
    );
    if (actor.kind === 'ADMIN') {
      await this.outbox.notify(
        {
          event: NotificationEvent.BOOKING_MATCHED,
          recipients: [booking.customerUserId],
          params: { bookingId: booking.id },
        },
        tx,
      );
    }
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
    // An interview or trial only exists while the booking is matched / scheduled / completed: any other move closes the open one.
    if (
      !['MATCHED', 'INTERVIEW_TRIAL_SCHEDULED', 'INTERVIEW_TRIAL_COMPLETED'].includes(change.status)
    ) {
      await this.interviews.cancelOpen(booking.id, `booking moved to ${change.status}`, tx);
    }
    // Alerts about a state the booking has left are closed by the move itself.
    if (change.status !== 'NEW_REQUEST') {
      await this.alerts.autoResolve(
        `BOOKING_NEEDS_MATCH:${booking.id}`,
        'the booking moved on',
        tx,
      );
    }
    if (change.status !== 'PENDING_PAYMENT') {
      await this.alerts.autoResolve(
        `BOOKING_STUCK_PAYMENT:${booking.id}`,
        'the booking moved on',
        tx,
      );
    }
    if (change.status !== 'MATCHED' || change.workerRespondedAt) {
      await this.alerts.autoResolve(
        `BOOKING_NO_RESPONSE:${booking.id}`,
        'the worker responded or the booking moved on',
        tx,
      );
    }
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
      id?: string;
      categoryId: string;
      areaId: string;
      engagement: BookingRecord['engagement'];
      fromMinute: number;
      toMinute: number;
      customerUserId?: string;
      /** The date the work starts; falls back to the requested start date, then today. */
      startDate?: string | null;
      requestedStartDate?: string | null;
      excludeBookingId?: string;
    },
    options: { tx?: Prisma.TransactionClient; lock?: boolean } = {},
  ): Promise<void> {
    const eligible = await this.search.isEligible({
      forCustomerUserId: requirement.customerUserId,
      workerId,
      categoryId: requirement.categoryId,
      areaId: requirement.areaId,
      engagement: requirement.engagement,
      window: { fromMinute: requirement.fromMinute, toMinute: requirement.toMinute },
      skipBusy: true,
    });
    if (!eligible) {
      throw new DomainException(
        BookingErrorCode.WORKER_NOT_ELIGIBLE,
        'The worker is not available for this requirement',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'workerId', messages: ['the worker is not eligible for this booking'] }],
      );
    }
    // Double-booking rule: a worker already booked for an overlapping time (same dates, overlapping hours) cannot be taken for this one.
    // Other hours of the same day, and any time after the other service ends, stay bookable.
    if (options.tx && options.lock) await this.repository.lockWorker(workerId, options.tx);
    const busy = await this.repository.isWorkerBusy(
      workerId,
      {
        startDate: requirement.startDate ?? requirement.requestedStartDate ?? indiaToday(),
        engagement: requirement.engagement,
        fromMinute: requirement.fromMinute,
        toMinute: requirement.toMinute,
        excludeBookingId: requirement.excludeBookingId ?? requirement.id,
        bufferMinutes: this.config.travelBufferMinutes,
      },
      options.tx,
    );
    if (busy) {
      throw new DomainException(
        BookingErrorCode.WORKER_UNAVAILABLE,
        'The worker is already booked for part of that time',
        HttpStatus.CONFLICT,
        [{ field: 'workerId', messages: ['the worker has another booking at that time'] }],
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
        addressId: b.addressId,
        requestedStartDate: b.requestedStartDate,
        budgetMinMinor: b.budgetMinMinor,
        budgetMaxMinor: b.budgetMaxMinor,
        budgetPeriod: b.budgetPeriod,
        requirementNote: b.requirementNote,
        workerRespondedAt: b.workerRespondedAt,
        respondBy: b.respondBy,
        proposedSlotAt: b.proposedSlotAt,
        proposedSlotNote: b.proposedSlotNote,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      };
    });
  }

  private async detail(booking: BookingRecord, forAdmin: boolean): Promise<BookingDetailView> {
    const [view] = forAdmin ? await this.views([booking]) : await this.customerViews([booking]);
    const events = await this.repository.listEvents(booking.id);
    return { ...view, timeline: events.map((e) => this.timelineEntry(e, forAdmin)) };
  }

  // --- what the customer's own booking responses add (worker identity, allowed actions, rating state) --------------------

  /** The common view plus `worker`, `allowedActions` and `rating`; every lookup is one statement for the whole page. */
  private async customerViews(bookings: BookingRecord[]): Promise<CustomerBookingView[]> {
    const views = await this.views(bookings);
    if (bookings.length === 0) return [];
    const shown = [
      ...new Set(
        bookings
          .filter((b) => b.workerId !== null && WORKER_VISIBLE_STATUSES.includes(b.status))
          .map((b) => b.workerId!),
      ),
    ];
    const [rated, displays, rebookable] = await Promise.all([
      this.hooks.ratedBookingIds(bookings.map((b) => b.id)),
      this.workerDisplays(shown),
      this.rebookable(bookings),
    ]);
    return bookings.map((b, i) => {
      const rating = evaluateRatingEligibility(b, {
        alreadyRated: rated.has(b.id),
        allowEndedEarly: this.config.ratingAllowEndedEarly,
      });
      const actions: CustomerAllowedAction[] = CUSTOMER_ALLOWED_ACTIONS.filter((a) =>
        this.customerCanNow(a, b, rating.eligible, rebookable.has(b.id)),
      );
      return {
        ...views[i],
        worker:
          b.workerId !== null && WORKER_VISIBLE_STATUSES.includes(b.status)
            ? (displays.get(b.workerId) ?? null)
            : null,
        allowedActions: actions,
        rating: { rated: rated.has(b.id), eligible: rating.eligible, code: rating.code },
      };
    });
  }

  private customerCanNow(
    action: CustomerAllowedAction,
    booking: BookingRecord,
    canRate: boolean,
    canRebook: boolean,
  ): boolean {
    switch (action) {
      case 'pay':
        return booking.status === 'PENDING_PAYMENT';
      case 'rate':
        return canRate;
      case 'rebook':
        return canRebook;
      case 'report-attendance-exception':
        return booking.status === 'ACTIVE' && booking.workerId !== null;
      default:
        return RULES[action].some(
          (r) => r.actors.includes('CUSTOMER') && r.from.includes(booking.status),
        );
    }
  }

  /**
   * Completed bookings whose worker could be booked again right now: the same checks creation makes (category and area still enabled,
   * engagement still offered, worker eligible and free, no open booking with them). Bounded by the page size; nothing else is queried.
   */
  private async rebookable(bookings: BookingRecord[]): Promise<Set<string>> {
    const candidates = bookings.filter((b) => b.status === 'COMPLETED' && b.workerId !== null);
    const ok = new Set<string>();
    await Promise.all(
      candidates.map(async (b) => {
        try {
          await this.categories.assertEngagementOffered(b.categoryId, b.engagement);
          const [category] = await this.categories.findByIds([b.categoryId]);
          if (!category?.isEnabled) return;
          await this.areas.requireEnabled(b.areaId);
          if (await this.repository.hasLiveBookingWith(b.customerUserId, b.workerId!, b.categoryId))
            return;
          await this.assertEligible(b.workerId!, {
            categoryId: b.categoryId,
            areaId: b.areaId,
            engagement: b.engagement,
            fromMinute: b.fromMinute,
            toMinute: b.toMinute,
            customerUserId: b.customerUserId,
            excludeBookingId: b.id,
          });
          ok.add(b.id);
        } catch {
          // not bookable again: no `rebook` action
        }
      }),
    );
    return ok;
  }

  /** The worker of a booking as the owning customer may see them (null before the interview stage); for Attendance. */
  async displayWorkerOf(booking: {
    status: string;
    workerId: string | null;
  }): Promise<WorkerDisplayView | null> {
    if (booking.workerId === null || !WORKER_VISIBLE_STATUSES.includes(booking.status)) return null;
    return (await this.workerDisplays([booking.workerId])).get(booking.workerId) ?? null;
  }

  /** Display name (first name and last initial) and photo links for several workers, in two statements in total. */
  async workerDisplays(workerIds: string[]): Promise<Map<string, WorkerDisplayView>> {
    if (workerIds.length === 0) return new Map();
    const [names, photos] = await Promise.all([
      this.workers.namesByIds(workerIds),
      this.search.photoLinks(workerIds),
    ]);
    const out = new Map<string, WorkerDisplayView>();
    for (const id of workerIds) {
      const name = names.get(id);
      if (name === undefined) continue;
      const parts = name.trim().split(/\s+/).filter(Boolean);
      const first = parts[0] ?? '';
      const last = parts.length > 1 ? parts[parts.length - 1] : '';
      const lastInitial = last ? Array.from(last)[0].toUpperCase() : '';
      out.set(id, {
        displayName: lastInitial ? `${first} ${lastInitial}.` : first,
        initials: (Array.from(first)[0] ?? '').toUpperCase() + lastInitial,
        photo: photos.get(id) ?? null,
      });
    }
    return out;
  }

  private timelineEntry(event: BookingEventRecord, forAdmin: boolean): TimelineEntry {
    return {
      from: event.fromStatus,
      to: event.toStatus,
      by: event.actorKind,
      // Staff notes (cancellation reasons, interview outcomes) are part of the customer's own booking history. A worker's own
      // free text when they step back (decline, interview cancelled: the booking moves back to NEW_REQUEST or MATCHED) is not shown
      // to the customer; the fixed phrases the system writes for worker actions are.
      note: !forAdmin && workerSteppedBack(event) ? null : event.note,
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
      requestedStartDate: view.requestedStartDate,
      budgetMinMinor: view.budgetMinMinor,
      budgetMaxMinor: view.budgetMaxMinor,
      budgetPeriod: view.budgetPeriod,
      requirementNote: view.requirementNote,
      workerRespondedAt: view.workerRespondedAt,
      respondBy: view.respondBy,
      proposedSlotAt: view.proposedSlotAt,
      proposedSlotNote: view.proposedSlotNote,
      updatedAt: view.updatedAt,
    };
  }

  /** Field rules that need no lookups (the lookups follow in create). */
  private validateRequest(dto: CreateBookingDto): void {
    if (dto.startDate !== undefined) {
      if (!isRealDate(dto.startDate)) {
        throw this.invalid('startDate', 'startDate is not a real date');
      }
      if (dto.startDate < indiaToday()) {
        throw this.invalid('startDate', 'startDate must be today or later');
      }
    }
    if (
      dto.budgetMinMinor !== undefined &&
      dto.budgetMaxMinor !== undefined &&
      dto.budgetMinMinor > dto.budgetMaxMinor
    ) {
      throw this.invalid('budgetMinMinor', 'budgetMinMinor must not exceed budgetMaxMinor');
    }
    if (
      dto.budgetPeriod !== undefined &&
      dto.budgetMinMinor === undefined &&
      dto.budgetMaxMinor === undefined
    ) {
      throw this.invalid('budgetPeriod', 'budgetPeriod needs a budget amount');
    }
  }

  /**
   * Scheduled job helper: cancels a booking that has waited for payment longer than the configured time. The normal cancellation
   * path runs (payment closed by the cancellation hook, both parties told); nothing is refunded here. false = not eligible any more.
   */
  /**
   * DEC-02: a matched worker who still has not answered after WORKER_REASSIGN_HOURS loses the booking back to matching, exactly as if they
   * had declined it (audited as booking.auto_reassign, customer told, staff alerted to find another worker). Safe to repeat: a booking that is no
   * longer waiting on that worker is left alone.
   */
  async autoReassignNoResponse(bookingId: string, respondByBefore: Date): Promise<boolean> {
    return this.repository.transaction(async (tx) => {
      const booking = await this.repository.lock(bookingId, tx);
      if (
        !booking ||
        booking.status !== 'MATCHED' ||
        booking.workerRespondedAt ||
        !booking.respondBy ||
        booking.respondBy >= respondByBefore
      ) {
        return false;
      }
      const actor: BookingActor = { kind: 'SYSTEM', userId: null };
      await this.interviews.cancelOpen(booking.id, 'the worker did not respond in time', tx);
      await this.move(
        booking,
        { status: 'NEW_REQUEST', workerId: null, workerRespondedAt: null, respondBy: null },
        actor,
        tx,
        { action: 'booking.auto_reassign', note: 'The matched worker did not respond in time' },
      );
      await this.outbox.notify(
        {
          event: NotificationEvent.WORKER_DECLINED,
          recipients: [booking.customerUserId],
          params: { bookingId: booking.id },
        },
        tx,
      );
      await this.alerts.raise(
        {
          dedupeKey: `BOOKING_NEEDS_MATCH:${booking.id}`,
          type: 'BOOKING_NEEDS_MATCH',
          severity: 'WARNING',
          title: 'A booking has no worker: the matched worker did not respond in time',
          requiredPermission: PermissionCode.BOOKING_MANAGE,
          entityType: 'booking',
          entityId: booking.id,
        },
        tx,
      );
      this.logger.log(`Booking ${booking.id} returned to matching: no worker response`);
      return true;
    });
  }

  async autoCancelUnpaid(bookingId: string, olderThanHours: number): Promise<boolean> {
    return this.repository.transaction(async (tx) => {
      const booking = await this.repository.lock(bookingId, tx);
      if (
        !booking ||
        booking.status !== 'PENDING_PAYMENT' ||
        Date.now() - booking.updatedAt.getTime() < olderThanHours * 3_600_000
      ) {
        return false;
      }
      const actor: BookingActor = { kind: 'SYSTEM', userId: null };
      await this.move(
        booking,
        {
          status: 'CANCELLED',
          cancelReason: `Not paid within ${olderThanHours} hours`,
          cancelledAt: new Date(),
          cancelledByUserId: null,
        },
        actor,
        tx,
        { action: 'booking.auto_cancel', note: `Not paid within ${olderThanHours} hours` },
      );
      await this.hooks.cancelled(booking.id, actor, tx, booking.status);
      await this.notifyBoth(
        booking,
        NotificationEvent.BOOKING_CANCELLED,
        { bookingId: booking.id },
        tx,
      );
      this.logger.log(`Booking ${booking.id} auto-cancelled: unpaid after ${olderThanHours} h`);
      return true;
    });
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
