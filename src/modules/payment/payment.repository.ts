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
  failureCode: string | null;
  paymentMethod: string | null;
  paymentMethodDetail: string | null;
  refundReason: string | null;
  refundProviderId: string | null;
  refundedAt: Date | null;
  refundedByUserId: string | null;
  reconcileAttempts: number;
  reconcileNextAt: Date | null;
  reconcileLastNote: string | null;
  createdAt: Date;
}

export type PaymentExceptionKindValue =
  | 'PAID_BOOKING_CANCELLED'
  | 'LATE_PAYMENT_BOOKING_NOT_PENDING'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_PAYMENT'
  | 'UNKNOWN_ORDER_EVENT'
  | 'RECONCILIATION_EXHAUSTED'
  | 'REFUND_STUCK'
  | 'REFUND_NOT_REQUESTED';

export interface PaymentExceptionRecord {
  id: string;
  kind: PaymentExceptionKindValue;
  status: 'OPEN' | 'RESOLVED';
  paymentId: string | null;
  bookingId: string | null;
  bookingStatus: string | null;
  paymentStatus: string | null;
  amountMinor: number | null;
  currency: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  requiredAction: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
}

export interface NewPaymentException {
  dedupeKey: string;
  kind: PaymentExceptionKindValue;
  paymentId?: string | null;
  bookingId?: string | null;
  bookingStatus?: string | null;
  paymentStatus?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  providerOrderId?: string | null;
  providerPaymentId?: string | null;
  requiredAction: string;
  details?: Record<string, unknown>;
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
    failureCode: row.failureCode,
    paymentMethod: row.paymentMethod,
    paymentMethodDetail: row.paymentMethodDetail,
    refundReason: row.refundReason,
    refundProviderId: row.refundProviderId,
    refundedAt: row.refundedAt,
    refundedByUserId: row.refundedByUserId,
    reconcileAttempts: row.reconcileAttempts,
    reconcileNextAt: row.reconcileNextAt,
    reconcileLastNote: row.reconcileLastNote,
    createdAt: row.createdAt,
  };
}

type ExceptionRow = Prisma.PaymentExceptionGetPayload<object>;

function toException(row: ExceptionRow): PaymentExceptionRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    paymentId: row.paymentId,
    bookingId: row.bookingId,
    bookingStatus: row.bookingStatus,
    paymentStatus: row.paymentStatus,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerOrderId: row.providerOrderId,
    providerPaymentId: row.providerPaymentId,
    requiredAction: row.requiredAction,
    details: (row.details as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
    resolutionNote: row.resolutionNote,
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
  failureCode?: string | null;
  paymentMethod?: string;
  paymentMethodDetail?: string;
  refundReason?: string;
  refundProviderId?: string | null;
  refundedAt?: Date;
  refundedByUserId?: string;
  reconcileAttempts?: number;
  reconcileNextAt?: Date | null;
  reconcileClaimedUntil?: Date | null;
  reconcileLastAt?: Date;
  reconcileLastNote?: string | null;
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

  async findByProviderPaymentId(
    providerPaymentId: string,
    db: Db = this.prisma,
  ): Promise<PaymentRecord | null> {
    const row = await db.payment.findUnique({ where: { providerPaymentId } });
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
      refunded?: boolean;
    },
    skip: number,
    take: number,
  ): Promise<{ items: PaymentRecord[]; total: number }> {
    const where: Prisma.PaymentWhereInput = {
      ...(filter.customerUserId ? { customerUserId: filter.customerUserId } : {}),
      ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.refunded && !filter.status
        ? {
            status: { in: ['REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'] as PaymentStatusValue[] },
          }
        : {}),
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

  /** Payments created in [from, to) for an export, oldest first, one row more than `limit` so the caller can tell it was cut. */
  async listForExport(from: Date, to: Date, limit: number): Promise<PaymentRecord[]> {
    const rows = await this.prisma.payment.findMany({
      where: { createdAt: { gte: from, lt: to } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    return rows.map(toRecord);
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
      eventKind?: string;
      providerOrderId?: string;
      providerPaymentId?: string;
      providerRefundId?: string;
      amountMinor?: number;
      currency?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO payment_events (id, provider_event_id, payment_id, outcome, applied, note, event_kind,
                                  provider_order_id, provider_payment_id, provider_refund_id, amount_minor, currency)
      VALUES (gen_random_uuid(), ${input.providerEventId}, ${input.paymentId}::uuid, ${input.outcome},
              ${input.applied}, ${input.note ?? null}, ${input.eventKind ?? null},
              ${input.providerOrderId ?? null}, ${input.providerPaymentId ?? null}, ${input.providerRefundId ?? null},
              ${input.amountMinor ?? null}, ${input.currency ?? null})
      ON CONFLICT (provider_event_id) DO NOTHING`;
    return inserted === 1;
  }

  /** Webhooks that raced ahead of their order (oldest first), with what they said, for replay. */
  async findUnknownOrderEvents(limit: number): Promise<
    Array<{
      providerEventId: string;
      outcome: string;
      providerOrderId: string;
      providerPaymentId: string;
      amountMinor: number;
      currency: string | null;
      createdAt: Date;
    }>
  > {
    const rows = await this.prisma.paymentEvent.findMany({
      where: {
        note: 'UNKNOWN_ORDER',
        applied: false,
        eventKind: 'PAYMENT',
        providerOrderId: { not: null },
        providerPaymentId: { not: null },
        amountMinor: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({
      providerEventId: r.providerEventId,
      outcome: r.outcome,
      providerOrderId: r.providerOrderId!,
      providerPaymentId: r.providerPaymentId!,
      amountMinor: r.amountMinor!,
      currency: r.currency,
      createdAt: r.createdAt,
    }));
  }

  // --- exceptions (money problems that need a person) -----------------------------------------------------------

  /** True if newly recorded; false if this problem was already recorded (open or resolved): never duplicated. */
  async createException(
    input: NewPaymentException,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO payment_exceptions (id, dedupe_key, kind, payment_id, booking_id, booking_status, payment_status,
                                      amount_minor, currency, provider_order_id, provider_payment_id, required_action, details)
      VALUES (gen_random_uuid(), ${input.dedupeKey}, ${input.kind}::"PaymentExceptionKind", ${input.paymentId ?? null}::uuid,
              ${input.bookingId ?? null}::uuid, ${input.bookingStatus ?? null}, ${input.paymentStatus ?? null},
              ${input.amountMinor ?? null}, ${input.currency ?? null}, ${input.providerOrderId ?? null},
              ${input.providerPaymentId ?? null}, ${input.requiredAction},
              ${input.details ? JSON.stringify(input.details) : null}::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  async listExceptions(
    filter: { status?: 'OPEN' | 'RESOLVED'; kind?: PaymentExceptionKindValue; paymentId?: string },
    skip: number,
    take: number,
  ): Promise<{ items: PaymentExceptionRecord[]; total: number }> {
    const where: Prisma.PaymentExceptionWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.paymentId ? { paymentId: filter.paymentId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentException.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.paymentException.count({ where }),
    ]);
    return { items: rows.map(toException), total };
  }

  async findException(id: string, db: Db = this.prisma): Promise<PaymentExceptionRecord | null> {
    const row = await db.paymentException.findUnique({ where: { id } });
    return row ? toException(row) : null;
  }

  /** Resolves an OPEN exception. false = it was not open (already resolved, or unknown). */
  async resolveException(
    id: string,
    resolvedByUserId: string,
    note: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.paymentException.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId, resolutionNote: note },
    });
    return result.count === 1;
  }

  /** Active admins who may act on money problems (payment.manage): the recipients of operational alerts. */
  async alertRecipientIds(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT u.id FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE p.code = 'payment.manage' AND u.status = 'ACTIVE' AND u.type = 'ADMIN'`;
    return rows.map((r) => r.id);
  }

  // --- recovery ---------------------------------------------------------------------------------------------

  /** The payment of a booking that still holds or will hold money, locked. Call only after the booking row is locked. */
  async lockOpenForBooking(
    bookingId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PaymentRecord | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM payments
      WHERE booking_id = ${bookingId}::uuid
        AND status IN ('CREATED', 'PENDING', 'SUCCEEDED', 'REFUND_PENDING', 'REFUND_FAILED')
      FOR UPDATE`;
    return rows.length === 1 ? this.findById(rows[0].id, tx) : null;
  }

  /**
   * Atomically claims up to `limit` payments whose check is due. The claim lasts `claimSeconds`; if the worker dies the claim
   * lapses and another worker takes the row. SKIP LOCKED makes concurrent workers pick different rows.
   */
  async claimDue(limit: number, claimSeconds: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE payments SET reconcile_claimed_until = now() + (${claimSeconds} * interval '1 second')
      WHERE id IN (
        SELECT id FROM payments
        WHERE reconcile_next_at IS NOT NULL AND reconcile_next_at <= now()
          AND (reconcile_claimed_until IS NULL OR reconcile_claimed_until < now())
        ORDER BY reconcile_next_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    return rows.map((r) => r.id);
  }

  /** SUCCEEDED payments of cancelled bookings that no exception covers yet - open or resolved (backstop for a missed hook). */
  async findPaidForCancelledBookings(
    limit: number,
  ): Promise<Array<{ paymentId: string; bookingId: string }>> {
    const rows = await this.prisma.$queryRaw<Array<{ payment_id: string; booking_id: string }>>`
      SELECT p.id AS payment_id, p.booking_id FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      WHERE p.status = 'SUCCEEDED' AND b.status = 'CANCELLED'
        AND NOT EXISTS (
          SELECT 1 FROM payment_exceptions e
          WHERE e.payment_id = p.id AND e.kind IN ('PAID_BOOKING_CANCELLED', 'LATE_PAYMENT_BOOKING_NOT_PENDING'))
      ORDER BY p.paid_at
      LIMIT ${limit}`;
    return rows.map((r) => ({ paymentId: r.payment_id, bookingId: r.booking_id }));
  }

  async recoverySummary(): Promise<{
    dueForCheck: number;
    claimedNow: number;
    oldestDueSeconds: number | null;
    waitingForCheck: number;
    openExceptions: number;
    openExceptionsByKind: Record<string, number>;
    unknownOrderEvents: number;
  }> {
    const [counts] = await this.prisma.$queryRaw<
      Array<{ due: bigint; claimed: bigint; waiting: bigint; oldest: number | null }>
    >`
      SELECT count(*) FILTER (WHERE reconcile_next_at <= now()) AS due,
             count(*) FILTER (WHERE reconcile_claimed_until > now()) AS claimed,
             count(*) AS waiting,
             EXTRACT(EPOCH FROM now() - min(reconcile_next_at) FILTER (WHERE reconcile_next_at <= now()))::float8 AS oldest
      FROM payments WHERE reconcile_next_at IS NOT NULL`;
    const kinds = await this.prisma.$queryRaw<Array<{ kind: string; n: bigint }>>`
      SELECT kind::text AS kind, count(*) AS n FROM payment_exceptions WHERE status = 'OPEN' GROUP BY kind`;
    const unknown = await this.prisma.paymentEvent.count({
      where: { note: 'UNKNOWN_ORDER', applied: false },
    });
    const byKind: Record<string, number> = {};
    let open = 0;
    for (const k of kinds) {
      byKind[k.kind] = Number(k.n);
      open += Number(k.n);
    }
    return {
      dueForCheck: Number(counts?.due ?? 0),
      claimedNow: Number(counts?.claimed ?? 0),
      waitingForCheck: Number(counts?.waiting ?? 0),
      oldestDueSeconds:
        counts?.oldest === null || counts?.oldest === undefined ? null : Math.floor(counts.oldest),
      openExceptions: open,
      openExceptionsByKind: byKind,
      unknownOrderEvents: unknown,
    };
  }

  async setEventResult(
    providerEventId: string,
    result: { applied: boolean; note: string },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.paymentEvent.update({ where: { providerEventId }, data: result });
  }
}
