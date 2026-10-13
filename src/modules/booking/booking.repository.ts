import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { workerBusyCondition, type BusyRequest } from '../../common/scheduling/worker-busy';
import type { Engagement } from '../search/search.types';
import type { BookingStatusValue, ScheduleTypeValue } from './dto/booking.dto';

type Db = Prisma.TransactionClient | PrismaService;

export interface BookingRecord {
  id: string;
  customerUserId: string;
  workerId: string | null;
  categoryId: string;
  areaId: string;
  engagement: Engagement;
  fromMinute: number;
  toMinute: number;
  status: BookingStatusValue;
  scheduleType: ScheduleTypeValue | null;
  scheduledAt: Date | null;
  outcomeNote: string | null;
  /** YYYY-MM-DD (India date) or null. */
  startDate: string | null;
  cancelReason: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  replacesBookingId: string | null;
  addressId: string | null;
  /** YYYY-MM-DD (India date): when the customer wants the service to begin (PRD 5.2). */
  requestedStartDate: string | null;
  budgetMinMinor: number | null;
  budgetMaxMinor: number | null;
  budgetPeriod: string | null;
  requirementNote: string | null;
  workerRespondedAt: Date | null;
  respondBy: Date | null;
  proposedSlotAt: Date | null;
  proposedSlotNote: string | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingEventRecord {
  bookingId: string;
  fromStatus: BookingStatusValue | null;
  toStatus: BookingStatusValue;
  actorUserId: string | null;
  actorKind: string;
  note: string | null;
  createdAt: Date;
}

type Row = Prisma.BookingGetPayload<object>;

function toRecord(row: Row): BookingRecord {
  return {
    id: row.id,
    customerUserId: row.customerUserId,
    workerId: row.workerId,
    categoryId: row.categoryId,
    areaId: row.areaId,
    engagement: row.engagement,
    fromMinute: row.fromMinute,
    toMinute: row.toMinute,
    status: row.status,
    scheduleType: row.scheduleType,
    scheduledAt: row.scheduledAt,
    outcomeNote: row.outcomeNote,
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt,
    cancelledByUserId: row.cancelledByUserId,
    replacesBookingId: row.replacesBookingId,
    addressId: row.addressId,
    requestedStartDate: row.requestedStartDate
      ? row.requestedStartDate.toISOString().slice(0, 10)
      : null,
    budgetMinMinor: row.budgetMinMinor,
    budgetMaxMinor: row.budgetMaxMinor,
    budgetPeriod: row.budgetPeriod,
    requirementNote: row.requirementNote,
    workerRespondedAt: row.workerRespondedAt,
    respondBy: row.respondBy,
    proposedSlotAt: row.proposedSlotAt,
    proposedSlotNote: row.proposedSlotNote,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface BookingChange {
  status: BookingStatusValue;
  workerId?: string | null;
  scheduleType?: ScheduleTypeValue | null;
  scheduledAt?: Date | null;
  outcomeNote?: string | null;
  startDate?: string | null;
  cancelReason?: string | null;
  cancelledAt?: Date | null;
  cancelledByUserId?: string | null;
  workerRespondedAt?: Date | null;
  respondBy?: Date | null;
}

export interface BookingFilter {
  customerUserId?: string;
  workerId?: string;
  status?: BookingStatusValue;
  categoryId?: string;
  areaId?: string;
  engagement?: Engagement;
  createdFrom?: Date;
  createdTo?: Date;
  /** Offered to a worker who has not accepted or declined yet. */
  awaitingWorkerResponse?: boolean;
  /** Not finished: neither COMPLETED, CANCELLED nor REPLACED. */
  openOnly?: boolean;
}

/** The only place in the application that touches the booking tables (Prisma models). */
@Injectable()
export class BookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async create(
    input: {
      customerUserId: string;
      categoryId: string;
      areaId: string;
      engagement: Engagement;
      fromMinute: number;
      toMinute: number;
      idempotencyKey?: string | null;
      requestHash?: string | null;
      replacesBookingId?: string | null;
      workerId?: string | null;
      status?: BookingStatusValue;
      addressId?: string | null;
      requestedStartDate?: string | null;
      budgetMinMinor?: number | null;
      budgetMaxMinor?: number | null;
      budgetPeriod?: string | null;
      requirementNote?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<BookingRecord> {
    return toRecord(
      await tx.booking.create({
        data: {
          customerUserId: input.customerUserId,
          categoryId: input.categoryId,
          areaId: input.areaId,
          engagement: input.engagement,
          fromMinute: input.fromMinute,
          toMinute: input.toMinute,
          idempotencyKey: input.idempotencyKey ?? null,
          requestHash: input.requestHash ?? null,
          replacesBookingId: input.replacesBookingId ?? null,
          workerId: input.workerId ?? null,
          status: input.status ?? 'NEW_REQUEST',
          addressId: input.addressId ?? null,
          requestedStartDate: input.requestedStartDate
            ? new Date(`${input.requestedStartDate}T00:00:00.000Z`)
            : null,
          budgetMinMinor: input.budgetMinMinor ?? null,
          budgetMaxMinor: input.budgetMaxMinor ?? null,
          budgetPeriod: input.budgetPeriod ?? null,
          requirementNote: input.requirementNote ?? null,
        },
      }),
    );
  }

  async findById(id: string, db: Db = this.prisma): Promise<BookingRecord | null> {
    const row = await db.booking.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(
    customerUserId: string,
    key: string,
    db: Db = this.prisma,
  ): Promise<BookingRecord | null> {
    const row = await db.booking.findUnique({
      where: { customerUserId_idempotencyKey: { customerUserId, idempotencyKey: key } },
    });
    return row ? toRecord(row) : null;
  }

  /** Serialises every change of one booking for the rest of the transaction. */
  async findManyByIds(ids: string[]): Promise<BookingRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.booking.findMany({ where: { id: { in: ids } } });
    return rows.map(toRecord);
  }

  async lock(id: string, tx: Prisma.TransactionClient): Promise<BookingRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM bookings WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1 ? this.findById(id, tx) : null;
  }

  async update(id: string, change: BookingChange, tx: Prisma.TransactionClient): Promise<void> {
    await tx.booking.update({
      where: { id },
      data: {
        status: change.status,
        workerId: change.workerId,
        scheduleType: change.scheduleType,
        scheduledAt: change.scheduledAt,
        outcomeNote: change.outcomeNote,
        startDate:
          change.startDate === undefined
            ? undefined
            : change.startDate === null
              ? null
              : new Date(`${change.startDate}T00:00:00.000Z`),
        cancelReason: change.cancelReason,
        cancelledAt: change.cancelledAt,
        cancelledByUserId: change.cancelledByUserId,
        workerRespondedAt: change.workerRespondedAt,
        respondBy: change.respondBy,
        // A proposed alternative slot only exists while the interview/trial is scheduled: any other move clears it.
        ...(change.status !== 'INTERVIEW_TRIAL_SCHEDULED'
          ? { proposedSlotAt: null, proposedSlotNote: null }
          : {}),
      },
    });
  }

  async setSlotProposal(
    id: string,
    proposal: { at: Date; note: string | null } | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.booking.update({
      where: { id },
      data: { proposedSlotAt: proposal?.at ?? null, proposedSlotNote: proposal?.note ?? null },
    });
  }

  async setSchedule(id: string, scheduledAt: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.booking.update({
      where: { id },
      data: { scheduledAt, proposedSlotAt: null, proposedSlotNote: null },
    });
  }

  /**
   * The whole replacement chain a booking belongs to, oldest first: walks back to the first booking and forward through every booking
   * that replaced the previous one. Ids only; the caller decides what each viewer may see.
   */
  async replacementChain(id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH RECURSIVE back AS (
        SELECT b.id, b.replaces_booking_id, 0 AS depth FROM bookings b WHERE b.id = ${id}::uuid
        UNION ALL
        SELECT p.id, p.replaces_booking_id, back.depth + 1
        FROM bookings p JOIN back ON p.id = back.replaces_booking_id
      ), root AS (
        SELECT id FROM back ORDER BY depth DESC LIMIT 1
      ), forward AS (
        SELECT b.id, b.created_at, 0 AS step FROM bookings b JOIN root ON b.id = root.id
        UNION ALL
        SELECT n.id, n.created_at, forward.step + 1
        FROM bookings n JOIN forward ON n.replaces_booking_id = forward.id
      )
      SELECT id FROM forward ORDER BY step ASC`);
    return rows.map((r) => r.id);
  }

  // --- scheduled-job queries ------------------------------------------------------------------------------------

  /** MATCHED opportunities whose response deadline has passed without an answer. */
  async findNoResponse(
    limit: number,
  ): Promise<Array<{ id: string; workerId: string | null; respondBy: Date }>> {
    const rows = await this.prisma.booking.findMany({
      where: { status: 'MATCHED', workerRespondedAt: null, respondBy: { lt: new Date() } },
      select: { id: true, workerId: true, respondBy: true },
      orderBy: { respondBy: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, workerId: r.workerId, respondBy: r.respondBy! }));
  }

  /** Bookings that have waited in PENDING_PAYMENT since before `olderThan` (the status last changed then). */
  async findWaitingForPayment(
    olderThan: Date,
    limit: number,
  ): Promise<Array<{ id: string; updatedAt: Date }>> {
    return this.prisma.booking.findMany({
      where: { status: 'PENDING_PAYMENT', updatedAt: { lt: olderThan } },
      select: { id: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  async addEvent(
    input: {
      bookingId: string;
      fromStatus: BookingStatusValue | null;
      toStatus: BookingStatusValue;
      actorUserId: string | null;
      actorKind: string;
      note?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.bookingEvent.create({ data: { ...input, note: input.note ?? null } });
  }

  async listEvents(bookingId: string, db: Db = this.prisma): Promise<BookingEventRecord[]> {
    const rows = await db.bookingEvent.findMany({
      where: { bookingId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      bookingId: r.bookingId,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      actorUserId: r.actorUserId,
      actorKind: r.actorKind,
      note: r.note,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Serialises every decision that gives one worker's time away (confirming a worker, replacing a worker) for the rest of the transaction,
   * so two customers confirming the same worker for overlapping times cannot both succeed.
   */
  async lockWorker(workerId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workerId}, 42))`;
  }

  async isWorkerBusy(
    workerId: string,
    request: BusyRequest,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const rows = await db.$queryRaw<Array<{ busy: boolean }>>(
      Prisma.sql`SELECT ${workerBusyCondition(Prisma.sql`${workerId}::uuid`, request)} AS busy`,
    );
    return rows[0]?.busy === true;
  }

  async list(
    filter: BookingFilter,
    skip: number,
    take: number,
  ): Promise<{ items: BookingRecord[]; total: number }> {
    const where: Prisma.BookingWhereInput = {
      ...(filter.customerUserId ? { customerUserId: filter.customerUserId } : {}),
      ...(filter.workerId ? { workerId: filter.workerId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.awaitingWorkerResponse ? { workerRespondedAt: null } : {}),
      ...(filter.openOnly && !filter.status
        ? { status: { notIn: ['COMPLETED', 'CANCELLED', 'REPLACED'] as BookingStatusValue[] } }
        : {}),
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.areaId ? { areaId: filter.areaId } : {}),
      ...(filter.engagement ? { engagement: filter.engagement } : {}),
      ...(filter.createdFrom || filter.createdTo
        ? {
            createdAt: {
              ...(filter.createdFrom ? { gte: filter.createdFrom } : {}),
              ...(filter.createdTo ? { lte: filter.createdTo } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.booking.count({ where }),
    ]);
    return { items: rows.map(toRecord), total };
  }
}
