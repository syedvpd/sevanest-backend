import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { PaymentStatusValue } from './dto/payment.dto';

type Db = Prisma.TransactionClient | PrismaService;

export interface FeeRecord {
  code: string;
  amountMinor: number;
  currency: string;
  isActive: boolean;
}

export interface PaymentRecord {
  id: string;
  bookingId: string;
  customerUserId: string;
  feeCode: string;
  amountMinor: number;
  currency: string;
  status: PaymentStatusValue;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  checkoutPayload: Record<string, unknown> | null;
  receiptNumber: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  refundReason: string | null;
  refundProviderId: string | null;
  refundedAt: Date | null;
  refundedByUserId: string | null;
  createdAt: Date;
}

type Row = Prisma.PaymentGetPayload<object>;

function toRecord(row: Row): PaymentRecord {
  return {
    id: row.id,
    bookingId: row.bookingId,
    customerUserId: row.customerUserId,
    feeCode: row.feeCode,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    providerOrderId: row.providerOrderId,
    providerPaymentId: row.providerPaymentId,
    checkoutPayload: (row.checkoutPayload as Record<string, unknown> | null) ?? null,
    receiptNumber: row.receiptNumber,
    paidAt: row.paidAt,
    failureReason: row.failureReason,
    refundReason: row.refundReason,
    refundProviderId: row.refundProviderId,
    refundedAt: row.refundedAt,
    refundedByUserId: row.refundedByUserId,
    createdAt: row.createdAt,
  };
}

export interface PaymentChange {
  status?: PaymentStatusValue;
  providerOrderId?: string;
  providerPaymentId?: string;
  checkoutPayload?: Record<string, unknown>;
  receiptNumber?: string;
  paidAt?: Date;
  failureReason?: string;
  refundReason?: string;
  refundProviderId?: string;
  refundedAt?: Date;
  refundedByUserId?: string;
}

/** The only place in the application that touches the payment tables (Prisma models). */
@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // --- fees -------------------------------------------------------------------------------------------------

  async findFee(code: string, db: Db = this.prisma): Promise<FeeRecord | null> {
    const row = await db.feeConfig.findUnique({ where: { code } });
    return row
      ? {
          code: row.code,
          amountMinor: row.amountMinor,
          currency: row.currency,
          isActive: row.isActive,
        }
      : null;
  }

  async listFees(): Promise<FeeRecord[]> {
    const rows = await this.prisma.feeConfig.findMany({ orderBy: { code: 'asc' } });
    return rows.map((r) => ({
      code: r.code,
      amountMinor: r.amountMinor,
      currency: r.currency,
      isActive: r.isActive,
    }));
  }

  async upsertFee(fee: FeeRecord, tx: Prisma.TransactionClient): Promise<void> {
    await tx.feeConfig.upsert({
      where: { code: fee.code },
      create: fee,
      update: { amountMinor: fee.amountMinor, currency: fee.currency, isActive: fee.isActive },
    });
  }

  // --- payments ---------------------------------------------------------------------------------------------

  async create(
    input: {
      bookingId: string;
      customerUserId: string;
      feeCode: string;
      amountMinor: number;
      currency: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PaymentRecord> {
    return toRecord(await tx.payment.create({ data: input }));
  }

  async findById(id: string, db: Db = this.prisma): Promise<PaymentRecord | null> {
    const row = await db.payment.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findByProviderOrderId(
    providerOrderId: string,
    db: Db = this.prisma,
  ): Promise<PaymentRecord | null> {
    const row = await db.payment.findUnique({ where: { providerOrderId } });
    return row ? toRecord(row) : null;
  }

  /** The payment of a booking that still holds or will hold money (the partial unique index allows at most one). */
  async findOpenForBooking(bookingId: string, db: Db = this.prisma): Promise<PaymentRecord | null> {
    const row = await db.payment.findFirst({
      where: {
        bookingId,
        status: { in: ['CREATED', 'PENDING', 'SUCCEEDED', 'REFUND_PENDING', 'REFUND_FAILED'] },
      },
    });
    return row ? toRecord(row) : null;
  }

  async lock(id: string, tx: Prisma.TransactionClient): Promise<PaymentRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM payments WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1 ? this.findById(id, tx) : null;
  }

  async update(id: string, change: PaymentChange, tx: Prisma.TransactionClient): Promise<void> {
    await tx.payment.update({
      where: { id },
      data: {
        ...change,
        checkoutPayload: change.checkoutPayload as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async list(
    filter: {
      customerUserId?: string;
      bookingId?: string;
      status?: PaymentStatusValue;
    },
    skip: number,
    take: number,
  ): Promise<{ items: PaymentRecord[]; total: number }> {
    const where: Prisma.PaymentWhereInput = {
      ...(filter.customerUserId ? { customerUserId: filter.customerUserId } : {}),
      ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items: rows.map(toRecord), total };
  }

  // --- provider events ---------------------------------------------------------------------------------------

  /** True if this notification is new; false if it was already received (a duplicate delivery). */
  async recordEvent(
    input: {
      providerEventId: string;
      paymentId: string | null;
      outcome: string;
      applied: boolean;
      note?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO payment_events (id, provider_event_id, payment_id, outcome, applied, note)
      VALUES (gen_random_uuid(), ${input.providerEventId}, ${input.paymentId}::uuid, ${input.outcome},
              ${input.applied}, ${input.note ?? null})
      ON CONFLICT (provider_event_id) DO NOTHING`;
    return inserted === 1;
  }

  async setEventResult(
    providerEventId: string,
    result: { applied: boolean; note: string },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.paymentEvent.update({ where: { providerEventId }, data: result });
  }
}
