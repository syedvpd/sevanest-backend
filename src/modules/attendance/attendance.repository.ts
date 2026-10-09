import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { ActorKindValue, AttendanceStatusValue } from './dto/attendance.dto';

type Db = Prisma.TransactionClient | PrismaService;

export interface AttendanceRecordRow {
  id: string;
  bookingId: string;
  workerId: string;
  /** YYYY-MM-DD */
  date: string;
  status: AttendanceStatusValue;
  note: string | null;
  recordedByUserId: string;
  recordedByKind: ActorKindValue;
  updatedAt: Date;
}

export interface AttendanceEventRow {
  recordId: string;
  fromStatus: AttendanceStatusValue | null;
  toStatus: AttendanceStatusValue;
  note: string | null;
  reason: string | null;
  actorUserId: string;
  actorKind: ActorKindValue;
  createdAt: Date;
}

function toRow(r: Prisma.AttendanceRecordGetPayload<object>): AttendanceRecordRow {
  return {
    id: r.id,
    bookingId: r.bookingId,
    workerId: r.workerId,
    date: r.date.toISOString().slice(0, 10),
    status: r.status,
    note: r.note,
    recordedByUserId: r.recordedByUserId,
    recordedByKind: r.recordedByKind,
    updatedAt: r.updatedAt,
  };
}

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** The only place that touches the attendance tables (Prisma models). */
@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async create(
    input: {
      bookingId: string;
      workerId: string;
      date: string;
      status: AttendanceStatusValue;
      note: string | null;
      recordedByUserId: string;
      recordedByKind: ActorKindValue;
    },
    tx: Prisma.TransactionClient,
  ): Promise<AttendanceRecordRow> {
    return toRow(await tx.attendanceRecord.create({ data: { ...input, date: day(input.date) } }));
  }

  async findForDay(
    bookingId: string,
    date: string,
    db: Db = this.prisma,
  ): Promise<AttendanceRecordRow | null> {
    const row = await db.attendanceRecord.findUnique({
      where: { bookingId_date: { bookingId, date: day(date) } },
    });
    return row ? toRow(row) : null;
  }

  async findById(id: string, db: Db = this.prisma): Promise<AttendanceRecordRow | null> {
    const row = await db.attendanceRecord.findUnique({ where: { id } });
    return row ? toRow(row) : null;
  }

  async lock(id: string, tx: Prisma.TransactionClient): Promise<AttendanceRecordRow | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM attendance_records WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1 ? this.findById(id, tx) : null;
  }

  async update(
    id: string,
    data: { status: AttendanceStatusValue; note: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.attendanceRecord.update({ where: { id }, data });
  }

  async addEvent(
    input: {
      recordId: string;
      fromStatus: AttendanceStatusValue | null;
      toStatus: AttendanceStatusValue;
      note: string | null;
      reason?: string | null;
      actorUserId: string;
      actorKind: ActorKindValue;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.attendanceEvent.create({ data: { ...input, reason: input.reason ?? null } });
  }

  async listEvents(recordIds: string[]): Promise<AttendanceEventRow[]> {
    if (recordIds.length === 0) return [];
    return this.prisma.attendanceEvent.findMany({
      where: { recordId: { in: recordIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async list(
    bookingId: string,
    range: { from?: string; to?: string },
    skip: number,
    take: number,
  ): Promise<{ items: AttendanceRecordRow[]; total: number }> {
    const where: Prisma.AttendanceRecordWhereInput = {
      bookingId,
      ...(range.from || range.to
        ? {
            date: {
              ...(range.from ? { gte: day(range.from) } : {}),
              ...(range.to ? { lte: day(range.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);
    return { items: rows.map(toRow), total };
  }
}
