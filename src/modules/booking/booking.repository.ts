import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
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
}

export interface BookingFilter {
  customerUserId?: string;
  workerId?: string;
  status?: BookingStatusValue;
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
      },
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

  async list(
    filter: BookingFilter,
    skip: number,
    take: number,
  ): Promise<{ items: BookingRecord[]; total: number }> {
    const where: Prisma.BookingWhereInput = {
      ...(filter.customerUserId ? { customerUserId: filter.customerUserId } : {}),
      ...(filter.workerId ? { workerId: filter.workerId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
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
