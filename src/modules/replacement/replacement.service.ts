import { HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import { indiaToday, isRealDate } from '../../common/time/india';
import type { Prisma } from '../../generated/prisma/client';
import { BookingLifecycleHooks } from '../booking/booking-hooks';
import { BookingActor, BookingService } from '../booking/booking.service';
import { MatchCandidatesResponse } from '../matching/dto/matching.dto';
import { MatchingService } from '../matching/matching.service';
import { WorkerCard } from '../search/dto/search.dto';
import { SearchService } from '../search/search.service';
import { WorkersService } from '../workers/workers.service';
import {
  AdminReplacementListQuery,
  AdminReplacementView,
  CreateReplacementDto,
  REPLACEMENT_REASONS,
  ReplacementDetailView,
  ReplacementListQuery,
  ReplacementTimelineEntry,
  ReplacementView,
} from './dto/replacement.dto';
import { REPLACEMENT_POLICY, type ReplacementPolicy } from './replacement.policy';
import { ReplacementRecord, ReplacementRepository } from './replacement.repository';

export const ReplacementErrorCode = {
  REPLACEMENT_NOT_FOUND: 'REPLACEMENT_NOT_FOUND',
  REPLACEMENT_NOT_ELIGIBLE: 'REPLACEMENT_NOT_ELIGIBLE',
  REPLACEMENT_ALREADY_OPEN: 'REPLACEMENT_ALREADY_OPEN',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  SAME_WORKER: 'SAME_WORKER',
} as const;

export interface ReplacementActor {
  kind: 'CUSTOMER' | 'ADMIN';
  userId: string;
  roles?: string[];
}

/**
 * Replacement workflow (SRS 3.13, FRD FM-06/FM-11): request -> staff review (approve/reject) -> alternative workers (Matching)
 * -> selection -> confirmation, with the old booking REPLACED and linked to the new one. Eligibility is a policy boundary
 * (`ReplacementPolicy`): the specification defines no rule beyond the booking state machine (Q-09), so the default only
 * requires an ACTIVE booking. The booking's own state moves through Booking's contract in the same transaction.
 */
@Injectable()
export class ReplacementService implements OnModuleInit {
  constructor(
    private readonly repository: ReplacementRepository,
    private readonly bookings: BookingService,
    private readonly hooks: BookingLifecycleHooks,
    private readonly matching: MatchingService,
    private readonly search: SearchService,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(REPLACEMENT_POLICY) private readonly policy: ReplacementPolicy,
  ) {}

  onModuleInit(): void {
    // A booking cancelled while a replacement is open closes that request in the cancelling transaction.
    this.hooks.register({
      onCancelled: async (bookingId, actor, tx) => {
        const open = await this.repository.findOpenForBooking(bookingId, tx);
        if (!open) return;
        const locked = await this.repository.lock(open.id, tx);
        if (!locked || !['REQUESTED', 'APPROVED'].includes(locked.status)) return;
        await this.repository.update(locked.id, { status: 'CANCELLED' }, tx);
        await this.audit.record(
          {
            action: 'replacement.cancel',
            entityType: 'replacement_request',
            entityId: locked.id,
            actorId: actor.userId,
            metadata: { from: locked.status, to: 'CANCELLED', cause: 'booking cancelled' },
          },
          tx,
        );
      },
    });
  }

  // --- customer ---------------------------------------------------------------------------------------------

  async request(customerUserId: string, dto: CreateReplacementDto): Promise<ReplacementView> {
    const booking = await this.bookings.getSummary(dto.bookingId).catch(() => null);
    if (!booking || booking.customerUserId !== customerUserId) throw this.bookingNotFound();
    if (await this.repository.findOpenForBooking(booking.id)) {
      throw this.alreadyOpen();
    }
    const reasonCode = dto.reasonCode ?? 'OTHER';
    if (!dto.reason && reasonCode === 'OTHER') {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'reason', messages: ['reason is required when the reason code is OTHER'] }],
      );
    }
    if (
      dto.neededFrom !== undefined &&
      (!isRealDate(dto.neededFrom) || dto.neededFrom < indiaToday())
    ) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'neededFrom', messages: ['neededFrom must be a real date, today or later'] }],
      );
    }
    const reasonText = dto.reason ?? REPLACEMENT_REASONS.find((r) => r.code === reasonCode)!.label;
    const verdict = await this.policy.evaluate(booking);
    if (!verdict.eligible) {
      throw new DomainException(
        ReplacementErrorCode.REPLACEMENT_NOT_ELIGIBLE,
        verdict.reason ?? 'This booking is not eligible for a replacement',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    try {
      const created = await this.repository.transaction(async (tx) => {
        await this.bookings.requestReplacement(booking.id, customerUserId, tx);
        const request = await this.repository.create(
          {
            bookingId: booking.id,
            requestedByUserId: customerUserId,
            reason: reasonText,
            reasonCode,
            notes: dto.notes ?? null,
            neededFrom: dto.neededFrom ? new Date(`${dto.neededFrom}T00:00:00.000Z`) : null,
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'replacement.request',
            entityType: 'replacement_request',
            entityId: request.id,
            actorId: customerUserId,
            metadata: { bookingId: booking.id },
          },
          tx,
        );
        await this.notify(request, booking.workerId, tx);
        return request;
      });
      return this.view(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw this.alreadyOpen();
      throw error;
    }
  }

  async listMine(
    customerUserId: string,
    query: ReplacementListQuery,
  ): Promise<Page<ReplacementView>> {
    const { items, total } = await this.repository.list(
      { requestedByUserId: customerUserId, status: query.status, bookingId: query.bookingId },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((r) => this.view(r)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async getMine(customerUserId: string, id: string): Promise<ReplacementDetailView> {
    const request = await this.repository.findById(id);
    if (!request || request.requestedByUserId !== customerUserId) throw this.notFound();
    return { ...this.view(request), timeline: await this.timeline(request) };
  }

  /**
   * Workers the customer may pick once staff approved the request: the staff candidate eligibility (never the worker being
   * replaced) as customer-safe worker cards. Selection checks again, including booking conflicts.
   */
  async alternatives(
    customerUserId: string,
    id: string,
    page: number,
    limit: number,
  ): Promise<Page<WorkerCard>> {
    const request = await this.repository.findById(id);
    if (!request || request.requestedByUserId !== customerUserId) throw this.notFound();
    if (request.status !== 'APPROVED') throw this.invalidTransition(request);
    const requirement = await this.bookings.getRequirement(request.bookingId);
    const { items, total } = await this.search.findEligible(
      {
        category: requirement.category,
        areaId: requirement.areaId,
        engagement: requirement.engagement,
        availableFrom: requirement.availableFrom,
        availableTo: requirement.availableTo,
        excludeWorkerId: requirement.workerId ?? undefined,
        forCustomerUserId: customerUserId,
      },
      'SUBMITTED_ASC',
      { skip: skipFor({ page, limit }), limit },
    );
    const cards = await this.search.getVisibleCards(
      items.map((w) => w.id),
      customerUserId,
    );
    return {
      data: items.map((w) => cards.get(w.id)).filter((c): c is WorkerCard => c !== undefined),
      meta: { page, limit, total },
    };
  }

  /** Withdraws an open request; the booking returns to ACTIVE. Repeating is harmless. */
  async cancel(customerUserId: string, id: string): Promise<ReplacementView> {
    const known = await this.repository.findById(id);
    if (!known || known.requestedByUserId !== customerUserId) throw this.notFound();
    await this.repository.transaction(async (tx) => {
      await this.bookings.lockBooking(known.bookingId, tx);
      const request = (await this.repository.lock(id, tx))!;
      if (request.status === 'CANCELLED') return;
      this.requireOpen(request);
      await this.repository.update(id, { status: 'CANCELLED' }, tx);
      await this.bookings.restoreActive(
        request.bookingId,
        { kind: 'CUSTOMER', userId: customerUserId },
        tx,
      );
      await this.audit.record(
        {
          action: 'replacement.cancel',
          entityType: 'replacement_request',
          entityId: id,
          actorId: customerUserId,
          metadata: { from: request.status, to: 'CANCELLED' },
        },
        tx,
      );
    });
    return this.view((await this.repository.findById(id))!);
  }

  // --- selection (customer or staff) -----------------------------------------------------------------------

  /** Confirms the replacement worker: creates the new booking and closes the old one as REPLACED, in one transaction. */
  async select(id: string, workerId: string, actor: ReplacementActor): Promise<ReplacementView> {
    const known = await this.repository.findById(id);
    if (!known || (actor.kind === 'CUSTOMER' && known.requestedByUserId !== actor.userId)) {
      throw this.notFound();
    }
    try {
      await this.repository.transaction(async (tx) => {
        await this.bookings.lockBooking(known.bookingId, tx);
        const request = (await this.repository.lock(id, tx))!;
        if (request.status === 'COMPLETED') {
          const done = await this.bookings.getSummary(request.replacementBookingId!);
          if (done.workerId === workerId) return;
          throw this.invalidTransition(request);
        }
        if (request.status !== 'APPROVED') throw this.invalidTransition(request);
        const old = await this.bookings.getSummary(request.bookingId);
        if (old.workerId === workerId) {
          throw new DomainException(
            ReplacementErrorCode.SAME_WORKER,
            'Choose a different worker than the one being replaced',
            HttpStatus.UNPROCESSABLE_ENTITY,
            [{ field: 'workerId', messages: ['must differ from the current worker'] }],
          );
        }
        const bookingActor: BookingActor = {
          kind: actor.kind,
          userId: actor.userId,
          roles: actor.roles,
        };
        const newBookingId = await this.bookings.completeReplacement(
          request.bookingId,
          workerId,
          bookingActor,
          tx,
        );
        await this.repository.update(
          id,
          { status: 'COMPLETED', replacementBookingId: newBookingId, completedAt: new Date() },
          tx,
        );
        await this.audit.record(
          {
            action: 'replacement.complete',
            entityType: 'replacement_request',
            entityId: id,
            actorId: actor.userId,
            actorRole: actor.roles?.join(',') || actor.kind,
            metadata: { bookingId: request.bookingId, replacementBookingId: newBookingId },
          },
          tx,
        );
        await this.notify({ ...request, status: 'COMPLETED' }, old.workerId, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          'DUPLICATE_BOOKING',
          'The customer already has an open booking with this worker for this service',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
    return this.view((await this.repository.findById(id))!);
  }

  // --- staff -----------------------------------------------------------------------------------------------

  async adminList(query: AdminReplacementListQuery): Promise<Page<AdminReplacementView>> {
    const { items, total } = await this.repository.list(
      { bookingId: query.bookingId, status: query.status },
      skipFor(query),
      query.limit,
    );
    return {
      data: await Promise.all(items.map((r) => this.adminView(r))),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(id: string): Promise<AdminReplacementView> {
    const request = await this.repository.findById(id);
    if (!request) throw this.notFound();
    return this.adminView(request);
  }

  async approve(
    id: string,
    remarks: string | undefined,
    message: string | undefined,
    admin: ReplacementActor,
  ): Promise<AdminReplacementView> {
    await this.decide(id, 'APPROVED', remarks, message, admin);
    return this.adminView((await this.repository.findById(id))!);
  }

  async reject(
    id: string,
    remarks: string,
    message: string | undefined,
    admin: ReplacementActor,
  ): Promise<AdminReplacementView> {
    await this.decide(id, 'REJECTED', remarks, message, admin);
    return this.adminView((await this.repository.findById(id))!);
  }

  /** Alternative workers for the booking's requirement, never the worker being replaced (FR-REP-005). */
  async candidates(
    id: string,
    admin: ReplacementActor,
    page: number,
    limit: number,
  ): Promise<MatchCandidatesResponse> {
    const request = await this.repository.findById(id);
    if (!request) throw this.notFound();
    const requirement = await this.bookings.getRequirement(request.bookingId);
    return this.matching.candidatesFor(
      {
        category: requirement.category,
        areaId: requirement.areaId,
        engagement: requirement.engagement,
        availableFrom: requirement.availableFrom,
        availableTo: requirement.availableTo,
        page,
        limit,
      },
      { userId: admin.userId, roles: admin.roles ?? [] },
      {
        excludeWorkerId: requirement.workerId ?? undefined,
        forCustomerUserId: requirement.customerUserId,
      },
    );
  }

  // --- internals --------------------------------------------------------------------------------------------

  private async decide(
    id: string,
    to: 'APPROVED' | 'REJECTED',
    remarks: string | undefined,
    message: string | undefined,
    admin: ReplacementActor,
  ): Promise<void> {
    if (to === 'REJECTED' && !remarks) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'remarks', messages: ['remarks are required to reject'] }],
      );
    }
    const known = await this.repository.findById(id);
    if (!known) throw this.notFound();
    await this.repository.transaction(async (tx) => {
      await this.bookings.lockBooking(known.bookingId, tx);
      const request = (await this.repository.lock(id, tx))!;
      if (request.status === to) return;
      if (request.status !== 'REQUESTED') throw this.invalidTransition(request);
      await this.repository.update(
        id,
        {
          status: to,
          decidedByUserId: admin.userId,
          decidedAt: new Date(),
          decisionRemarks: remarks ?? null,
          decisionMessage: message ?? null,
        },
        tx,
      );
      if (to === 'REJECTED') {
        await this.bookings.restoreActive(
          request.bookingId,
          { kind: 'ADMIN', userId: admin.userId, roles: admin.roles },
          tx,
        );
      }
      await this.audit.record(
        {
          action: to === 'APPROVED' ? 'replacement.approve' : 'replacement.reject',
          entityType: 'replacement_request',
          entityId: id,
          actorId: admin.userId,
          actorRole: admin.roles?.join(',') || null,
          metadata: { from: request.status, to },
        },
        tx,
      );
      const booking = await this.bookings.getSummary(request.bookingId);
      await this.notify({ ...request, status: to }, booking.workerId, tx);
    });
  }

  private async notify(
    request: ReplacementRecord,
    workerId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const booking = await this.bookings.getSummary(request.bookingId);
    const recipients = [booking.customerUserId];
    if (workerId) recipients.push((await this.workers.requireRefById(workerId)).userId);
    await this.outbox.notify(
      {
        event: NotificationEvent.REPLACEMENT_UPDATE,
        recipients,
        params: { bookingId: request.bookingId, replacementId: request.id, status: request.status },
      },
      tx,
    );
  }

  private requireOpen(request: ReplacementRecord): void {
    if (!['REQUESTED', 'APPROVED'].includes(request.status)) throw this.invalidTransition(request);
  }

  /** Status history from the audit trail, which is written in the same transaction as every change. */
  private async timeline(r: ReplacementRecord): Promise<ReplacementTimelineEntry[]> {
    const { items } = await this.audit.search(
      { entityType: 'replacement_request', entityId: r.id, actionPrefix: 'replacement.' },
      0,
      50,
    );
    const status: Record<string, ReplacementTimelineEntry['status']> = {
      'replacement.request': 'REQUESTED',
      'replacement.approve': 'APPROVED',
      'replacement.reject': 'REJECTED',
      'replacement.cancel': 'CANCELLED',
      'replacement.complete': 'COMPLETED',
    };
    return items
      .filter((row) => status[row.action])
      .reverse()
      .map((row) => {
        const to = status[row.action];
        const cause = (row.metadata as { cause?: string } | null)?.cause;
        const actor: ReplacementTimelineEntry['actor'] = cause
          ? 'SYSTEM'
          : row.actorId === r.requestedByUserId
            ? 'CUSTOMER'
            : 'STAFF';
        return {
          status: to,
          at: row.createdAt,
          actor,
          remarks: to === 'APPROVED' || to === 'REJECTED' ? r.decisionMessage : null,
        };
      });
  }

  private view(r: ReplacementRecord): ReplacementView {
    return {
      id: r.id,
      bookingId: r.bookingId,
      status: r.status,
      reasonCode: r.reasonCode,
      reason: r.reason,
      notes: r.notes,
      neededFrom: r.neededFrom ? r.neededFrom.toISOString().slice(0, 10) : null,
      decisionMessage: r.decisionMessage,
      replacementBookingId: r.replacementBookingId,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      completedAt: r.completedAt,
    };
  }

  private async adminView(r: ReplacementRecord): Promise<AdminReplacementView> {
    const booking = await this.bookings.getSummary(r.bookingId);
    return {
      ...this.view(r),
      decisionRemarks: r.decisionRemarks,
      requestedByUserId: r.requestedByUserId,
      decidedByUserId: r.decidedByUserId,
      currentWorkerId: booking.workerId,
    };
  }

  private alreadyOpen(): DomainException {
    return new DomainException(
      ReplacementErrorCode.REPLACEMENT_ALREADY_OPEN,
      'A replacement request is already open for this booking',
      HttpStatus.CONFLICT,
    );
  }

  private invalidTransition(request: ReplacementRecord): DomainException {
    return new DomainException(
      ReplacementErrorCode.INVALID_TRANSITION,
      `A replacement request that is ${request.status} cannot do that`,
      HttpStatus.CONFLICT,
    );
  }

  private bookingNotFound(): DomainException {
    return new DomainException('BOOKING_NOT_FOUND', 'Booking not found', HttpStatus.NOT_FOUND);
  }

  private notFound(): DomainException {
    return new DomainException(
      ReplacementErrorCode.REPLACEMENT_NOT_FOUND,
      'Replacement request not found',
      HttpStatus.NOT_FOUND,
    );
  }
}
