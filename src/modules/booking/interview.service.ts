import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { Page, skipFor } from '../../common/pagination/pagination';
import { WorkersService } from '../workers/workers.service';
import {
  AdminInterviewListQuery,
  CancelInterviewDto,
  CompleteInterviewDto,
  DeclineInterviewDto,
  INTERVIEW_STATUS_LABELS,
  InterviewListQuery,
  InterviewView,
  type InterviewStatusValue,
  ProposeInterviewDto,
  RequestInterviewDto,
  RescheduleInterviewDto,
} from './dto/interview.dto';
import { BookingRecord, BookingRepository } from './booking.repository';
import { BookingActor, BookingErrorCode, BookingService } from './booking.service';
import { InterviewRecord, InterviewRepository } from './interview.repository';

export const InterviewErrorCode = {
  INTERVIEW_NOT_FOUND: 'INTERVIEW_NOT_FOUND',
  INTERVIEW_ALREADY_OPEN: 'INTERVIEW_ALREADY_OPEN',
  INVALID_INTERVIEW_STATE: 'INVALID_INTERVIEW_STATE',
} as const;

type Tx = Prisma.TransactionClient;

const ACTIONS: Record<InterviewStatusValue, InterviewView['allowedActions']> = {
  REQUESTED: ['reschedule', 'cancel'],
  CONFIRMED: ['reschedule', 'cancel', 'complete'],
  RESCHEDULE_PROPOSED: ['accept-proposal', 'reject-proposal', 'cancel'],
  DECLINED: [],
  CANCELLED: [],
  COMPLETED: [],
};

function timelineOf(r: InterviewRecord): InterviewView['timeline'] {
  const t: InterviewView['timeline'] = [{ title: 'Requested', state: 'done', at: r.createdAt }];
  if (r.status === 'REQUESTED')
    t.push({ title: 'Waiting for the worker', state: 'current', at: null });
  if (r.proposedAt && r.status === 'RESCHEDULE_PROPOSED')
    t.push({ title: 'New time proposed', state: 'current', at: r.proposedAt });
  if (r.status === 'DECLINED')
    t.push({ title: 'Declined by the worker', state: 'failed', at: r.updatedAt });
  if (r.status === 'CANCELLED') t.push({ title: 'Cancelled', state: 'failed', at: r.cancelledAt });
  if (r.scheduledAt && (r.status === 'CONFIRMED' || r.status === 'COMPLETED'))
    t.push({ title: 'Confirmed', state: 'done', at: r.scheduledAt });
  if (r.status === 'CONFIRMED') t.push({ title: 'Outcome', state: 'upcoming', at: null });
  if (r.status === 'COMPLETED') t.push({ title: 'Completed', state: 'done', at: r.completedAt });
  return t;
}

export function toInterviewView(r: InterviewRecord): InterviewView {
  return {
    allowedActions: ACTIONS[r.status],
    timeline: timelineOf(r),
    id: r.id,
    bookingId: r.bookingId,
    type: r.type,
    status: r.status,
    statusLabel: INTERVIEW_STATUS_LABELS[r.status],
    requestedBy: r.requestedByKind,
    preferredAt: r.preferredAt,
    scheduledAt: r.scheduledAt,
    proposedAt: r.proposedAt,
    proposedBy: r.proposedByKind,
    note: r.note,
    declineReason: r.declineReason,
    cancelReason: r.cancelReason,
    outcomeNote: r.outcomeNote,
    completedAt: r.completedAt,
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * The interview / trial workflow (PRD 5.4, 6.3, 12 "Interview/Trial: schedule, status, outcome"; FRD FM-06/FM-08). A booking can have
 * several sessions over time but only one open at a time. The booking keeps its coarse state - MATCHED (nothing agreed),
 * INTERVIEW_TRIAL_SCHEDULED (a time is agreed), INTERVIEW_TRIAL_COMPLETED (done, the customer may now confirm the worker) - and this service
 * moves it, in the same transaction as the session, so the two can never disagree. Every operation locks the booking row first (the same
 * order as the rest of the booking module), checks who is asking, then applies the transition table:
 *
 *   REQUESTED            --worker accepts--------> CONFIRMED            (booking -> SCHEDULED at the requested time)
 *   REQUESTED            --worker declines-------> DECLINED
 *   REQUESTED/CONFIRMED  --worker proposes time---> RESCHEDULE_PROPOSED
 *   RESCHEDULE_PROPOSED  --customer accepts-------> CONFIRMED            (booking -> SCHEDULED at the proposed time)
 *   RESCHEDULE_PROPOSED  --customer rejects-------> CONFIRMED (a time was agreed before) or REQUESTED
 *   open                 --customer reschedules---> REQUESTED            (booking back to MATCHED while nothing is agreed)
 *   open                 --anyone cancels---------> CANCELLED            (booking back to MATCHED if it was scheduled)
 *   CONFIRMED            --customer/staff completes-> COMPLETED          (booking -> COMPLETED with the outcome)
 *
 * Not decided by the business and therefore NOT invented: the duration of a session (so no overlap checks between sessions), the
 * outcome values (free text, Q-55), the number of rounds, and notice periods.
 */
@Injectable()
export class InterviewService {
  constructor(
    private readonly bookingRepo: BookingRepository,
    private readonly repo: InterviewRepository,
    private readonly bookings: BookingService,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // --- reading ---------------------------------------------------------------------------------------------

  async listForCustomer(userId: string, bookingId: string): Promise<InterviewView[]> {
    const booking = await this.bookingRepo.findById(bookingId);
    if (!booking || booking.customerUserId !== userId) throw this.bookingNotFound();
    return (await this.repo.listForBooking(bookingId)).map(toInterviewView);
  }

  async pageForCustomer(userId: string, query: InterviewListQuery): Promise<Page<InterviewView>> {
    const { items, total } = await this.repo.listForCustomer(
      userId,
      { status: query.status, type: query.type },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map(toInterviewView),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async upcomingForCustomer(userId: string): Promise<InterviewView | null> {
    const next = await this.repo.nextConfirmedForCustomer(userId, new Date());
    return next ? toInterviewView(next) : null;
  }

  async listForAdmin(bookingId: string): Promise<InterviewView[]> {
    if (!(await this.bookingRepo.findById(bookingId))) throw this.bookingNotFound();
    return (await this.repo.listForBooking(bookingId)).map(toInterviewView);
  }

  async listForWorker(workerId: string, query: InterviewListQuery): Promise<Page<InterviewView>> {
    const { items, total } = await this.repo.listForWorker(
      workerId,
      { status: query.status, type: query.type },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map(toInterviewView),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminSearch(query: AdminInterviewListQuery): Promise<Page<InterviewView>> {
    const { items, total } = await this.repo.listAdmin(
      { status: query.status, type: query.type, bookingId: query.bookingId },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map(toInterviewView),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async get(interviewId: string, actor: BookingActor): Promise<InterviewView> {
    const session = await this.repo.findById(interviewId);
    if (!session) throw this.notFound();
    const booking = await this.bookingRepo.findById(session.bookingId);
    if (!booking || !this.owns(booking, actor)) throw this.notFound();
    return toInterviewView(session);
  }

  // --- the customer asks -----------------------------------------------------------------------------------

  async request(
    bookingId: string,
    dto: RequestInterviewDto,
    actor: BookingActor,
  ): Promise<InterviewView> {
    const preferredAt = this.future(dto.preferredAt, 'preferredAt');
    const id = await this.bookingRepo.transaction(async (tx) => {
      const booking = await this.bookingRepo.lock(bookingId, tx);
      if (!booking || !this.owns(booking, actor)) throw this.bookingNotFound();
      if (!booking.workerId || !['MATCHED', 'INTERVIEW_TRIAL_COMPLETED'].includes(booking.status)) {
        throw this.invalidBooking(booking, 'request an interview or trial');
      }
      if (await this.repo.findOpen(booking.id, tx)) {
        throw new DomainException(
          InterviewErrorCode.INTERVIEW_ALREADY_OPEN,
          'This booking already has an interview or trial in progress: answer, reschedule or cancel it first',
          HttpStatus.CONFLICT,
        );
      }
      const created = await this.repo.create(
        {
          bookingId: booking.id,
          type: dto.type,
          status: 'REQUESTED',
          requestedByKind: actor.kind,
          requestedByUserId: actor.userId,
          preferredAt,
          note: dto.note ?? null,
        },
        tx,
      );
      await this.trail(
        booking,
        actor,
        `${dto.type.toLowerCase()} requested`,
        'interview.request',
        created,
        tx,
      );
      await this.notifyWorker(booking, NotificationEvent.INTERVIEW_REQUESTED, created, tx);
      return created.id;
    });
    return toInterviewView((await this.repo.findById(id))!);
  }

  // --- the worker answers ----------------------------------------------------------------------------------

  /** Accepts the requested time (a worker, or staff on the worker's behalf). Repeating an accepted session changes nothing. */
  accept(interviewId: string, actor: BookingActor): Promise<InterviewView> {
    return this.session(interviewId, actor, ['WORKER', 'ADMIN'], async (booking, s, tx) => {
      if (s.status === 'CONFIRMED') return s;
      this.requireStatus(s, ['REQUESTED']);
      const updated = await this.repo.update(
        s.id,
        { status: 'CONFIRMED', scheduledAt: s.preferredAt },
        tx,
      );
      await this.schedule(booking, updated, s.preferredAt, actor, tx, 'interview.accept');
      return updated;
    });
  }

  decline(
    interviewId: string,
    dto: DeclineInterviewDto,
    actor: BookingActor,
  ): Promise<InterviewView> {
    return this.session(interviewId, actor, ['WORKER'], async (booking, s, tx) => {
      this.requireStatus(s, ['REQUESTED']);
      const updated = await this.repo.update(
        s.id,
        { status: 'DECLINED', declineReason: dto.reason },
        tx,
      );
      await this.trail(
        booking,
        actor,
        `${s.type.toLowerCase()} declined`,
        'interview.decline',
        updated,
        tx,
      );
      await this.outbox.notify(
        {
          event: NotificationEvent.INTERVIEW_RESPONDED,
          recipients: [booking.customerUserId],
          params: { bookingId: booking.id, interviewId: s.id, answer: 'DECLINED' },
        },
        tx,
      );
      return updated;
    });
  }

  /** The worker cannot make the time and proposes another; the customer answers. A new proposal replaces the previous one. */
  propose(
    interviewId: string,
    dto: ProposeInterviewDto,
    actor: BookingActor,
  ): Promise<InterviewView> {
    const proposedAt = this.future(dto.proposedAt, 'proposedAt');
    return this.session(interviewId, actor, ['WORKER'], async (booking, s, tx) => {
      this.requireStatus(s, ['REQUESTED', 'CONFIRMED', 'RESCHEDULE_PROPOSED']);
      if (s.proposedAt?.getTime() === proposedAt.getTime()) return s;
      if (proposedAt.getTime() === (s.scheduledAt ?? s.preferredAt).getTime()) {
        throw this.invalid('proposedAt', 'that is already the requested or agreed time');
      }
      const updated = await this.repo.update(
        s.id,
        {
          status: 'RESCHEDULE_PROPOSED',
          proposedAt,
          proposedByKind: 'WORKER',
          note: dto.note ?? s.note,
        },
        tx,
      );
      await this.trail(booking, actor, 'another time proposed', 'interview.propose', updated, tx);
      await this.outbox.notify(
        {
          event: NotificationEvent.INTERVIEW_RESPONDED,
          recipients: [booking.customerUserId],
          params: { bookingId: booking.id, interviewId: s.id, answer: 'PROPOSED_ANOTHER_TIME' },
        },
        tx,
      );
      return updated;
    });
  }

  // --- the customer answers a proposal / changes the plan ---------------------------------------------------

  acceptProposal(interviewId: string, actor: BookingActor): Promise<InterviewView> {
    return this.session(interviewId, actor, ['CUSTOMER', 'ADMIN'], async (booking, s, tx) => {
      this.requireStatus(s, ['RESCHEDULE_PROPOSED']);
      if (!s.proposedAt || s.proposedAt.getTime() <= Date.now()) {
        throw this.invalid('proposedAt', 'the proposed time has already passed');
      }
      const at = s.proposedAt;
      const updated = await this.repo.update(
        s.id,
        { status: 'CONFIRMED', scheduledAt: at, proposedAt: null, proposedByKind: null },
        tx,
      );
      await this.schedule(booking, updated, at, actor, tx, 'interview.accept_proposal');
      return updated;
    });
  }

  rejectProposal(interviewId: string, actor: BookingActor): Promise<InterviewView> {
    return this.session(interviewId, actor, ['CUSTOMER', 'ADMIN'], async (booking, s, tx) => {
      this.requireStatus(s, ['RESCHEDULE_PROPOSED']);
      const updated = await this.repo.update(
        s.id,
        {
          status: s.scheduledAt ? 'CONFIRMED' : 'REQUESTED',
          proposedAt: null,
          proposedByKind: null,
        },
        tx,
      );
      await this.trail(
        booking,
        actor,
        'proposed time not accepted',
        'interview.reject_proposal',
        updated,
        tx,
      );
      await this.notifyWorker(
        booking,
        NotificationEvent.INTERVIEW_RESPONDED,
        updated,
        tx,
        'KEPT_ORIGINAL',
      );
      return updated;
    });
  }

  /** The customer wants another time: the session goes back to REQUESTED for the worker to answer. */
  reschedule(
    interviewId: string,
    dto: RescheduleInterviewDto,
    actor: BookingActor,
  ): Promise<InterviewView> {
    const preferredAt = this.future(dto.preferredAt, 'preferredAt');
    return this.session(interviewId, actor, ['CUSTOMER', 'ADMIN'], async (booking, s, tx) => {
      this.requireStatus(s, ['REQUESTED', 'CONFIRMED', 'RESCHEDULE_PROPOSED']);
      if (s.status === 'REQUESTED' && s.preferredAt.getTime() === preferredAt.getTime()) return s;
      const updated = await this.repo.update(
        s.id,
        {
          status: 'REQUESTED',
          preferredAt,
          scheduledAt: null,
          proposedAt: null,
          proposedByKind: null,
          note: dto.note ?? s.note,
        },
        tx,
      );
      if (booking.status === 'INTERVIEW_TRIAL_SCHEDULED') {
        await this.bookings.moveForInterview(
          booking,
          { status: 'MATCHED', scheduleType: null, scheduledAt: null },
          actor,
          tx,
          { action: 'interview.reschedule', note: 'interview time changed' },
        );
      }
      await this.trail(
        booking,
        actor,
        `${s.type.toLowerCase()} rescheduled`,
        'interview.reschedule',
        updated,
        tx,
        booking.status === 'INTERVIEW_TRIAL_SCHEDULED',
      );
      await this.notifyWorker(booking, NotificationEvent.INTERVIEW_REQUESTED, updated, tx);
      return updated;
    });
  }

  cancel(
    interviewId: string,
    dto: CancelInterviewDto,
    actor: BookingActor,
  ): Promise<InterviewView> {
    return this.session(
      interviewId,
      actor,
      ['CUSTOMER', 'WORKER', 'ADMIN'],
      async (booking, s, tx) => {
        this.requireStatus(s, ['REQUESTED', 'CONFIRMED', 'RESCHEDULE_PROPOSED']);
        const updated = await this.repo.update(
          s.id,
          {
            status: 'CANCELLED',
            cancelReason: dto.reason,
            cancelledAt: new Date(),
            proposedAt: null,
            proposedByKind: null,
          },
          tx,
        );
        const wasScheduled = booking.status === 'INTERVIEW_TRIAL_SCHEDULED';
        if (wasScheduled) {
          await this.bookings.moveForInterview(
            booking,
            { status: 'MATCHED', scheduleType: null, scheduledAt: null },
            actor,
            tx,
            { action: 'interview.cancel', note: dto.reason },
          );
        }
        await this.trail(
          booking,
          actor,
          `${s.type.toLowerCase()} cancelled`,
          'interview.cancel',
          updated,
          tx,
          wasScheduled,
        );
        const recipients: string[] = [];
        if (actor.kind !== 'CUSTOMER') recipients.push(booking.customerUserId);
        if (actor.kind !== 'WORKER' && booking.workerId) {
          recipients.push((await this.workers.requireRefById(booking.workerId)).userId);
        }
        await this.outbox.notify(
          {
            event: NotificationEvent.INTERVIEW_CANCELLED,
            recipients,
            params: { bookingId: booking.id, interviewId: s.id },
          },
          tx,
        );
        return updated;
      },
    );
  }

  /** The interview or trial took place: record the outcome. The booking moves on so the customer can confirm the worker. */
  complete(
    interviewId: string,
    dto: CompleteInterviewDto,
    actor: BookingActor,
  ): Promise<InterviewView> {
    return this.session(interviewId, actor, ['CUSTOMER', 'ADMIN'], async (booking, s, tx) => {
      this.requireStatus(s, ['CONFIRMED']);
      const updated = await this.repo.update(
        s.id,
        { status: 'COMPLETED', outcomeNote: dto.outcomeNote, completedAt: new Date() },
        tx,
      );
      await this.bookings.moveForInterview(
        booking,
        { status: 'INTERVIEW_TRIAL_COMPLETED', outcomeNote: dto.outcomeNote },
        actor,
        tx,
        { action: 'interview.complete', note: dto.outcomeNote },
      );
      await this.audit.record(
        {
          action: 'interview.complete',
          entityType: 'interview_trial',
          entityId: s.id,
          actorId: actor.userId,
          actorRole: actor.roles?.join(',') || null,
          metadata: { bookingId: booking.id },
        },
        tx,
      );
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
      return updated;
    });
  }

  // --- internals --------------------------------------------------------------------------------------------

  /** Runs `work` with the booking of the session locked, after checking that the caller may act on it in this role. */
  private async session(
    interviewId: string,
    actor: BookingActor,
    roles: Array<BookingActor['kind']>,
    work: (booking: BookingRecord, session: InterviewRecord, tx: Tx) => Promise<InterviewRecord>,
  ): Promise<InterviewView> {
    if (!roles.includes(actor.kind)) {
      throw new DomainException(
        BookingErrorCode.ACTION_NOT_ALLOWED,
        'This action is not available to you',
        HttpStatus.FORBIDDEN,
      );
    }
    const first = await this.repo.findById(interviewId);
    if (!first) throw this.notFound();
    const result = await this.bookingRepo.transaction(async (tx) => {
      const booking = await this.bookingRepo.lock(first.bookingId, tx);
      if (!booking || !this.owns(booking, actor)) throw this.notFound();
      const session = await this.repo.findById(interviewId, tx);
      if (!session) throw this.notFound();
      return work(booking, session, tx);
    });
    return toInterviewView((await this.repo.findById(result.id))!);
  }

  /** The session is now agreed for `at`: move the booking to SCHEDULED, notify both sides, leave the audit trail. */
  private async schedule(
    booking: BookingRecord,
    s: InterviewRecord,
    at: Date,
    actor: BookingActor,
    tx: Tx,
    action: string,
  ): Promise<void> {
    if (
      !['MATCHED', 'INTERVIEW_TRIAL_COMPLETED', 'INTERVIEW_TRIAL_SCHEDULED'].includes(
        booking.status,
      )
    ) {
      throw this.invalidBooking(booking, 'schedule an interview or trial');
    }
    await this.bookings.moveForInterview(
      booking,
      {
        status: 'INTERVIEW_TRIAL_SCHEDULED',
        scheduleType: s.type,
        scheduledAt: at,
        outcomeNote: null,
        ...(booking.workerRespondedAt ? {} : { workerRespondedAt: new Date() }),
      },
      actor,
      tx,
      { action, note: `${s.type.toLowerCase()} scheduled` },
    );
    await this.audit.record(
      {
        action,
        entityType: 'interview_trial',
        entityId: s.id,
        actorId: actor.userId,
        actorRole: actor.roles?.join(',') || null,
        metadata: { bookingId: booking.id, scheduledAt: at.toISOString() },
      },
      tx,
    );
    const recipients = [booking.customerUserId];
    if (booking.workerId)
      recipients.push((await this.workers.requireRefById(booking.workerId)).userId);
    await this.outbox.notify(
      {
        event: NotificationEvent.INTERVIEW_TRIAL_SCHEDULED,
        recipients,
        params: { bookingId: booking.id, scheduleType: s.type, scheduledAt: at.toISOString() },
      },
      tx,
    );
  }

  /** A timeline entry (the booking state does not change) plus the audit record. */
  private async trail(
    booking: BookingRecord,
    actor: BookingActor,
    note: string,
    action: string,
    s: InterviewRecord,
    tx: Tx,
    skipTimeline = false,
  ): Promise<void> {
    if (!skipTimeline) {
      await this.bookingRepo.addEvent(
        {
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: booking.status,
          actorUserId: actor.userId,
          actorKind: actor.kind,
          note,
        },
        tx,
      );
    }
    await this.audit.record(
      {
        action,
        entityType: 'interview_trial',
        entityId: s.id,
        actorId: actor.userId,
        actorRole: actor.roles?.join(',') || null,
        metadata: { bookingId: booking.id, type: s.type, status: s.status },
      },
      tx,
    );
  }

  private async notifyWorker(
    booking: BookingRecord,
    event: (typeof NotificationEvent)[keyof typeof NotificationEvent],
    s: InterviewRecord,
    tx: Tx,
    answer?: string,
  ): Promise<void> {
    if (!booking.workerId) return;
    await this.outbox.notify(
      {
        event,
        recipients: [(await this.workers.requireRefById(booking.workerId)).userId],
        params: {
          bookingId: booking.id,
          interviewId: s.id,
          ...(answer ? { answer } : {}),
        },
      },
      tx,
    );
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

  private requireStatus(s: InterviewRecord, allowed: Array<InterviewRecord['status']>): void {
    if (!allowed.includes(s.status)) {
      throw new DomainException(
        InterviewErrorCode.INVALID_INTERVIEW_STATE,
        `An interview or trial that is ${s.status} cannot do that`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private invalidBooking(booking: BookingRecord, what: string): DomainException {
    return new DomainException(
      BookingErrorCode.INVALID_TRANSITION,
      `A booking that is ${booking.status}${booking.workerId ? '' : ' without a worker'} cannot ${what}`,
      HttpStatus.CONFLICT,
    );
  }

  private future(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      throw this.invalid(field, `${field} must be a time in the future`);
    }
    return date;
  }

  private invalid(field: string, message: string): DomainException {
    return new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field, messages: [message] }],
    );
  }

  private notFound(): DomainException {
    return new DomainException(
      InterviewErrorCode.INTERVIEW_NOT_FOUND,
      'Interview or trial not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private bookingNotFound(): DomainException {
    return new DomainException(
      BookingErrorCode.BOOKING_NOT_FOUND,
      'Booking not found',
      HttpStatus.NOT_FOUND,
    );
  }
}
