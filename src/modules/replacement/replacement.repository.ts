import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { ReplacementReasonCode, ReplacementStatusValue } from './dto/replacement.dto';

type Db = Prisma.TransactionClient | PrismaService;

export interface ReplacementRecord {
  id: string;
  bookingId: string;
  requestedByUserId: string;
  reason: string;
  reasonCode: ReplacementReasonCode;
  notes: string | null;
  neededFrom: Date | null;
  status: ReplacementStatusValue;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionRemarks: string | null;
  decisionMessage: string | null;
  replacementBookingId: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface ReplacementChange {
  status: ReplacementStatusValue;
  decidedByUserId?: string;
  decidedAt?: Date;
  decisionRemarks?: string | null;
  decisionMessage?: string | null;
  replacementBookingId?: string;
  completedAt?: Date;
}

export interface ReplacementReasonSettingRecord {
  code: ReplacementReasonCode;
  label: string;
  isEnabled: boolean;
  updatedByUserId: string | null;
  updatedAt: Date;
}

/** The only place that touches the replacement table (Prisma model). */
@Injectable()
export class ReplacementRepository {
  constructor(private readonly prisma: PrismaService) {}

  listReasonSettings(enabledOnly = false): Promise<ReplacementReasonSettingRecord[]> {
    return this.prisma.replacementReasonSetting.findMany({
      where: enabledOnly ? { isEnabled: true } : {},
      orderBy: [{ code: 'asc' }],
    });
  }

  findReasonSetting(
    code: ReplacementReasonCode,
    db: Db = this.prisma,
  ): Promise<ReplacementReasonSettingRecord | null> {
    return db.replacementReasonSetting.findUnique({ where: { code } });
  }

  async lockReasonSetting(
    code: ReplacementReasonCode,
    tx: Prisma.TransactionClient,
  ): Promise<ReplacementReasonSettingRecord | null> {
    const rows = await tx.$queryRaw<Array<{ code: string }>>`
      SELECT code FROM replacement_reason_settings WHERE code = ${code}::"ReplacementReason" FOR UPDATE`;
    return rows.length === 1 ? this.findReasonSetting(code, tx) : null;
  }

  updateReasonSetting(
    code: ReplacementReasonCode,
    data: { label?: string; isEnabled?: boolean; updatedByUserId: string },
    tx: Prisma.TransactionClient,
  ): Promise<ReplacementReasonSettingRecord> {
    return tx.replacementReasonSetting.update({ where: { code }, data });
  }

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  create(
    input: {
      bookingId: string;
      requestedByUserId: string;
      reason: string;
      reasonCode: ReplacementReasonCode;
      notes: string | null;
      neededFrom: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<ReplacementRecord> {
    return tx.replacementRequest.create({ data: input });
  }

  findById(id: string, db: Db = this.prisma): Promise<ReplacementRecord | null> {
    return db.replacementRequest.findUnique({ where: { id } });
  }

  findOpenForBooking(bookingId: string, db: Db = this.prisma): Promise<ReplacementRecord | null> {
    return db.replacementRequest.findFirst({
      where: { bookingId, status: { in: ['REQUESTED', 'APPROVED'] } },
    });
  }

  async lock(id: string, tx: Prisma.TransactionClient): Promise<ReplacementRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM replacement_requests WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1 ? this.findById(id, tx) : null;
  }

  async update(id: string, change: ReplacementChange, tx: Prisma.TransactionClient): Promise<void> {
    await tx.replacementRequest.update({ where: { id }, data: change });
  }

  async list(
    filter: { requestedByUserId?: string; bookingId?: string; status?: ReplacementStatusValue },
    skip: number,
    take: number,
  ): Promise<{ items: ReplacementRecord[]; total: number }> {
    const where: Prisma.ReplacementRequestWhereInput = {
      ...(filter.requestedByUserId ? { requestedByUserId: filter.requestedByUserId } : {}),
      ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.replacementRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.replacementRequest.count({ where }),
    ]);
    return { items, total };
  }
}
