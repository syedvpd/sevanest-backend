import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { InterviewStatusValue, InterviewTypeValue } from './dto/interview.dto';

type Db = Prisma.TransactionClient | PrismaService;

export const OPEN_STATUSES: InterviewStatusValue[] = [
  'REQUESTED',
  'CONFIRMED',
  'RESCHEDULE_PROPOSED',
];

export interface InterviewRecord {
  id: string;
  bookingId: string;
  type: InterviewTypeValue;
  status: InterviewStatusValue;
  requestedByKind: string;
  requestedByUserId: string | null;
  preferredAt: Date;
  scheduledAt: Date | null;
  proposedAt: Date | null;
  proposedByKind: string | null;
  note: string | null;
  declineReason: string | null;
  cancelReason: string | null;
  outcomeNote: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InterviewChange = Partial<
  Pick<
    InterviewRecord,
    | 'type'
    | 'status'
    | 'preferredAt'
    | 'scheduledAt'
    | 'proposedAt'
    | 'proposedByKind'
    | 'note'
    | 'declineReason'
    | 'cancelReason'
    | 'outcomeNote'
    | 'completedAt'
    | 'cancelledAt'
  >
>;

/** The only place that touches `interview_trials`. Booking-level rules (state moves, locks) stay in the booking services. */
@Injectable()
export class InterviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string, db: Db = this.prisma): Promise<InterviewRecord | null> {
    return db.interviewTrial.findUnique({ where: { id } });
  }

  /** The open session of a booking (at most one: partial unique index). */
  findOpen(bookingId: string, db: Db = this.prisma): Promise<InterviewRecord | null> {
    return db.interviewTrial.findFirst({
      where: { bookingId, status: { in: OPEN_STATUSES } },
    });
  }

  async listForBooking(bookingId: string): Promise<InterviewRecord[]> {
    return await this.prisma.interviewTrial.findMany({
      where: { bookingId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async listForWorker(
    workerId: string,
    filter: { status?: InterviewStatusValue; type?: InterviewTypeValue },
    skip: number,
    take: number,
  ): Promise<{ items: InterviewRecord[]; total: number }> {
    const where: Prisma.InterviewTrialWhereInput = {
      booking: { workerId },
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
    };
    return this.page(where, skip, take);
  }

  async listForCustomer(
    customerUserId: string,
    filter: { status?: InterviewStatusValue; type?: InterviewTypeValue },
    skip: number,
    take: number,
  ): Promise<{ items: InterviewRecord[]; total: number }> {
    const where: Prisma.InterviewTrialWhereInput = {
      booking: { customerUserId },
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
    };
    return this.page(where, skip, take);
  }

  /** The customer's next agreed interview or trial that has not happened yet. */
  async nextConfirmedForCustomer(
    customerUserId: string,
    now: Date,
  ): Promise<InterviewRecord | null> {
    return this.prisma.interviewTrial.findFirst({
      where: { booking: { customerUserId }, status: 'CONFIRMED', scheduledAt: { gte: now } },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    });
  }

  async listAdmin(
    filter: { status?: InterviewStatusValue; type?: InterviewTypeValue; bookingId?: string },
    skip: number,
    take: number,
  ): Promise<{ items: InterviewRecord[]; total: number }> {
    const where: Prisma.InterviewTrialWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
    };
    return this.page(where, skip, take);
  }

  private async page(
    where: Prisma.InterviewTrialWhereInput,
    skip: number,
    take: number,
  ): Promise<{ items: InterviewRecord[]; total: number }> {
    const [items, total] = await Promise.all([
      this.prisma.interviewTrial.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.interviewTrial.count({ where }),
    ]);
    return { items: items, total };
  }

  async create(
    data: {
      bookingId: string;
      type: InterviewTypeValue;
      status: InterviewStatusValue;
      requestedByKind: string;
      requestedByUserId: string | null;
      preferredAt: Date;
      scheduledAt?: Date | null;
      note?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<InterviewRecord> {
    return tx.interviewTrial.create({ data });
  }

  async update(
    id: string,
    change: InterviewChange,
    tx: Prisma.TransactionClient,
  ): Promise<InterviewRecord> {
    return tx.interviewTrial.update({ where: { id }, data: change });
  }

  /**
   * The booking-level `schedule` action (kept for staff and older clients) still produces a real session: it confirms the open request if
   * there is one, otherwise it records a new CONFIRMED session, so the entity always matches the booking.
   */
  async confirmLegacy(
    bookingId: string,
    input: { type: InterviewTypeValue; at: Date; kind: string; userId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const open = await this.findOpen(bookingId, tx);
    if (open) {
      await tx.interviewTrial.update({
        where: { id: open.id },
        data: {
          type: input.type,
          status: 'CONFIRMED',
          scheduledAt: input.at,
          proposedAt: null,
          proposedByKind: null,
        },
      });
      return;
    }
    await tx.interviewTrial.create({
      data: {
        bookingId,
        type: input.type,
        status: 'CONFIRMED',
        requestedByKind: input.kind,
        requestedByUserId: input.userId,
        preferredAt: input.at,
        scheduledAt: input.at,
      },
    });
  }

  /** The booking-level `interview-complete` action completes the open session. */
  async completeLegacy(
    bookingId: string,
    outcomeNote: string | undefined,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.interviewTrial.updateMany({
      where: { bookingId, status: { in: OPEN_STATUSES } },
      data: {
        status: 'COMPLETED',
        outcomeNote: outcomeNote ?? null,
        completedAt: new Date(),
        proposedAt: null,
        proposedByKind: null,
      },
    });
  }

  /** The booking-level slot proposal (worker) is mirrored on the open session. */
  async mirrorProposal(
    bookingId: string,
    proposal: { at: Date; by: string } | null,
    acceptedAt: Date | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const open = await this.findOpen(bookingId, tx);
    if (!open) return;
    await tx.interviewTrial.update({
      where: { id: open.id },
      data: proposal
        ? { status: 'RESCHEDULE_PROPOSED', proposedAt: proposal.at, proposedByKind: proposal.by }
        : {
            status: 'CONFIRMED',
            proposedAt: null,
            proposedByKind: null,
            ...(acceptedAt ? { scheduledAt: acceptedAt } : {}),
          },
    });
  }

  /** Closes the open session of a booking because the booking itself was cancelled, declined or re-opened. */
  async cancelOpen(bookingId: string, reason: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.interviewTrial.updateMany({
      where: { bookingId, status: { in: OPEN_STATUSES } },
      data: {
        status: 'CANCELLED',
        cancelReason: reason,
        cancelledAt: new Date(),
        proposedAt: null,
        proposedByKind: null,
      },
    });
  }
}
