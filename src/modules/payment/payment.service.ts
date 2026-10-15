import { csvCell } from '../../common/csv/csv';
import { buildTextPdf, type PdfLine } from '../../common/pdf/simple-pdf';
import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { isRealDate } from '../../common/time/india';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import type { Prisma } from '../../generated/prisma/client';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderPaymentDetails,
  type ProviderPaymentOutcome,
  type ProviderRefund,
  type ProviderWebhookEvent,
} from '../../integrations/payments/payment-provider.interface';
import { ProviderError } from '../../integrations/provider-error';
import { AlertsService } from '../alerts/alerts.service';
import { BookingService } from '../booking/booking.service';
import { PermissionCode } from '../users/rbac.constants';
import {
  AdminPaymentListQuery,
  AdminPaymentView,
  BOOKING_FEE_CODE,
  CheckoutView,
  CreatePaymentResponse,
  BookingFeeQuote,
  FeeView,
  PaymentListQuery,
  PaymentView,
  ReceiptView,
  RefundDto,
  SetFeeDto,
  VerifyPaymentDto,
} from './dto/payment.dto';
import { nextCheckDelayMs, RECOVERY } from './payment-recovery.constants';
import {
  FeeRecord,
  NewPaymentException,
  PaymentExceptionRecord,
  PaymentRecord,
  PaymentRepository,
} from './payment.repository';

export const PaymentErrorCode = {
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  BOOKING_NOT_PAYABLE: 'BOOKING_NOT_PAYABLE',
  FEE_NOT_CONFIGURED: 'FEE_NOT_CONFIGURED',
  ALREADY_PAID: 'ALREADY_PAID',
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_PAYMENT_STATE: 'INVALID_PAYMENT_STATE',
  NOTHING_TO_RECONCILE: 'NOTHING_TO_RECONCILE',
  EXCEPTION_NOT_FOUND: 'PAYMENT_EXCEPTION_NOT_FOUND',
  EXCEPTION_NOT_OPEN: 'PAYMENT_EXCEPTION_NOT_OPEN',
} as const;

/** Technical cap on one export (not a reporting rule). */
export const EXPORT_MAX_ROWS = 5000;

export { csvCell };

export interface PaymentActor {
  userId: string;
  roles: string[];
}

type Applied = 'APPLIED' | 'DUPLICATE' | 'IGNORED' | 'MISMATCH';

interface GatewayReport extends ProviderPaymentDetails {
  providerPaymentId: string;
  outcome: ProviderPaymentOutcome;
  amountMinor: number;
  currency?: string;
}

interface ApplyContext {
  source: string;
  eventId?: string;
  /** Re-application of an already stored notification (it raced ahead of its order): update that row, never insert another. */
  replayEventId?: string;
  actor?: PaymentActor;
}

/** Payment states in which no more gateway answer is expected: the recovery schedule is cleared. */
const FINAL_FOR_RECOVERY = new Set(['SUCCEEDED', 'REFUNDED', 'REFUND_FAILED']);

/**
 * Payments (SRS 3.6, FRD FM-07). Owns the payment tables and the payment state machine; the gateway is reached only through
 * the PaymentProvider abstraction. State changes come ONLY from the gateway (a verified webhook, a server-side verification of a
 * client report, or a reconciliation read) - never from what a client claims. Booking is told about success through its own
 * contract inside the same transaction. Lock order everywhere: booking row first, then payment row (cancellation does the same),
 * so a payment callback and a cancellation can never deadlock.
 *
 * Money that cannot be handled by a rule (late payment for a cancelled booking, amount mismatch, duplicate charge, stuck refund)
 * becomes a durable PaymentException plus an alert to staff - never a silent success and never an invented refund.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly repository: PaymentRepository,
    private readonly bookings: BookingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly alerts: AlertsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  // --- fees (admin) ------------------------------------------------------------------------------------------

  async listFees(): Promise<FeeView[]> {
    return this.repository.listFees();
  }

  async setFee(code: string, dto: SetFeeDto, admin: PaymentActor): Promise<FeeView> {
    const fee: FeeRecord = {
      code,
      amountMinor: dto.amountMinor,
      currency: dto.currency ?? 'INR',
      isActive: dto.isActive ?? true,
    };
    await this.repository.transaction(async (tx) => {
      const before = await this.repository.findFee(code, tx);
      await this.repository.upsertFee(fee, tx);
      await this.audit.record(
        {
          action: 'payment.fee_set',
          entityType: 'fee_config',
          entityId: code,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { before, after: fee },
        },
        tx,
      );
    });
    return fee;
  }

  // --- customer ----------------------------------------------------------------------------------------------

  /** The one place that decides which fee a new booking payment charges (used by the quote and by createForBooking). */
  private async requireActiveBookingFee(): Promise<FeeRecord> {
    const fee = await this.repository.findFee(BOOKING_FEE_CODE);
    if (!fee || !fee.isActive) {
      throw new DomainException(
        PaymentErrorCode.FEE_NOT_CONFIGURED,
        'The booking fee has not been configured',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return fee;
  }

  /**
   * What paying a booking costs, before the payment step. Without a booking it is the active fee configuration; with one of my
   * bookings that already has a payment, it is that payment's own amount (a later fee change never alters an open payment).
   * 422 FEE_NOT_CONFIGURED when nothing would be charged; another customer's booking answers 404.
   */
  async quoteBookingFee(customerUserId: string, bookingId?: string): Promise<BookingFeeQuote> {
    if (bookingId) {
      const booking = await this.bookings.getSummary(bookingId).catch(() => null);
      if (!booking || booking.customerUserId !== customerUserId) throw this.bookingNotFound();
      const open = await this.repository.findOpenForBooking(bookingId);
      if (open) {
        return { code: open.feeCode, amountMinor: open.amountMinor, currency: open.currency };
      }
    }
    const fee = await this.requireActiveBookingFee();
    return { code: fee.code, amountMinor: fee.amountMinor, currency: fee.currency };
  }

  /** Starts (or resumes) the payment of a booking the customer owns. The amount always comes from the fee configuration. */
  async createForBooking(
    customerUserId: string,
    bookingId: string,
  ): Promise<CreatePaymentResponse> {
    const booking = await this.bookings.getSummary(bookingId).catch(() => null);
    if (!booking || booking.customerUserId !== customerUserId) throw this.bookingNotFound();
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new DomainException(
        PaymentErrorCode.BOOKING_NOT_PAYABLE,
        'This booking is not waiting for payment',
        HttpStatus.CONFLICT,
      );
    }
    let payment = await this.repository.findOpenForBooking(bookingId);
    if (payment?.status === 'SUCCEEDED' || payment?.status.startsWith('REFUND')) {
      throw new DomainException(
        PaymentErrorCode.ALREADY_PAID,
        'This booking is already paid',
        HttpStatus.CONFLICT,
      );
    }
    if (!payment) {
      const fee = await this.requireActiveBookingFee();
      try {
        payment = await this.repository.transaction(async (tx) => {
          // Re-check under the booking lock: a cancellation that committed meanwhile must not get a new payable order.
          await this.bookings.lockBooking(bookingId, tx);
          if ((await this.bookings.statusInTx(bookingId, tx)) !== 'PENDING_PAYMENT') {
            throw new DomainException(
              PaymentErrorCode.BOOKING_NOT_PAYABLE,
              'This booking is not waiting for payment',
              HttpStatus.CONFLICT,
            );
          }
          const created = await this.repository.create(
            {
              bookingId,
              customerUserId,
              feeCode: fee.code,
              amountMinor: fee.amountMinor,
              currency: fee.currency,
            },
            tx,
          );
          await this.audit.record(
            {
              action: 'payment.create',
              entityType: 'payment',
              entityId: created.id,
              actorId: customerUserId,
              metadata: { bookingId, amountMinor: created.amountMinor, currency: created.currency },
            },
            tx,
          );
          return created;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        payment = await this.repository.findOpenForBooking(bookingId);
        if (!payment) throw error;
      }
    }
    if (!payment.providerOrderId) {
      payment = await this.openOrder(payment);
    }
    return { ...this.view(payment), checkout: this.checkout(payment.checkoutPayload) };
  }

  /**
   * The client reports a finished checkout. The report is only a hint: the gateway is asked to verify it (signature) and
   * its answer, not the client's claim, decides.
   */
  async verifyReported(
    customerUserId: string,
    paymentId: string,
    dto: VerifyPaymentDto,
  ): Promise<PaymentView> {
    const payment = await this.repository.findById(paymentId);
    if (!payment || payment.customerUserId !== customerUserId) throw this.notFound();
    if (!payment.providerOrderId) {
      throw new DomainException(
        PaymentErrorCode.INVALID_PAYMENT_STATE,
        'No checkout was started for this payment',
        HttpStatus.CONFLICT,
      );
    }
    let reported: ProviderPayment;
    try {
      reported = await this.provider.verifyPayment({
        providerOrderId: payment.providerOrderId,
        providerPaymentId: dto.providerPaymentId,
        signature: dto.signature,
      });
    } catch (error) {
      throw this.providerFailure(error, PaymentErrorCode.PAYMENT_VERIFICATION_FAILED);
    }
    await this.applyOutcome(
      payment.providerOrderId,
      {
        providerPaymentId: reported.providerPaymentId,
        outcome: reported.outcome,
        amountMinor: reported.amountMinor,
        currency: reported.currency,
        method: reported.method,
        methodDetail: reported.methodDetail,
        errorCode: reported.errorCode,
        errorDescription: reported.errorDescription,
      },
      { source: 'client-verification' },
    );
    return this.view((await this.repository.findById(paymentId))!);
  }

  /** Contract for the customer History: money still held per booking, and in total for a year/category (D-78). */
  heldByBooking(bookingIds: string[]): Promise<Map<string, number>> {
    return this.repository.heldByBooking(bookingIds);
  }

  heldForCustomer(
    customerUserId: string,
    filter: { year?: number; category?: string },
  ): Promise<number> {
    return this.repository.heldForCustomer(customerUserId, {
      year: filter.year,
      categoryCode: filter.category,
    });
  }

  async listMine(customerUserId: string, query: PaymentListQuery): Promise<Page<PaymentView>> {
    const { items, total } = await this.repository.list(
      {
        customerUserId,
        status: query.status,
        bookingId: query.bookingId,
        refunded: query.refunded,
      },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((p) => this.view(p)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** Receipt of a paid payment (also after a refund). 409 RECEIPT_NOT_AVAILABLE before it is paid. */
  async receiptMine(customerUserId: string, paymentId: string): Promise<ReceiptView> {
    const payment = await this.repository.findById(paymentId);
    if (!payment || payment.customerUserId !== customerUserId) throw this.notFound();
    if (!payment.receiptNumber || !payment.paidAt) {
      throw new DomainException(
        'RECEIPT_NOT_AVAILABLE',
        'A receipt exists only for a successful payment',
        HttpStatus.CONFLICT,
      );
    }
    const view = this.view(payment);
    return {
      receiptNumber: payment.receiptNumber,
      paymentId: payment.id,
      bookingId: payment.bookingId,
      feeCode: payment.feeCode,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      paidAt: payment.paidAt,
      paymentMethod: payment.paymentMethod,
      paymentMethodDetail: payment.paymentMethodDetail,
      gatewayReference: payment.providerPaymentId,
      status: payment.status,
      refundStatus: view.refundStatus,
      refundedAt: payment.refundedAt,
    };
  }

  /**
   * The same receipt as a one-page PDF. Deliberately a plain payment receipt, NOT a GST tax invoice: the invoice format (legal
   * entity, GSTIN, SAC, tax split, numbering) is not approved (Q-100), so the document says so instead of inventing it.
   */
  async receiptPdfMine(
    customerUserId: string,
    paymentId: string,
  ): Promise<{ fileName: string; pdf: Buffer }> {
    const r = await this.receiptMine(customerUserId, paymentId);
    const paidAt = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(r.paidAt);
    const amount = `${r.currency} ${(r.amountMinor / 100).toFixed(2)}`;
    const method = [r.paymentMethod, r.paymentMethodDetail].filter(Boolean).join(' - ');
    const row = (label: string, value: string | null): PdfLine => ({
      text: `${label}:  ${value ?? '-'}`,
    });
    const lines: PdfLine[] = [
      { text: 'SevaNest', size: 20, bold: true },
      { text: 'Payment receipt', size: 14, bold: true, gapBefore: 4 },
      { text: 'This is a payment receipt, not a tax invoice.', size: 9, gapBefore: 2 },
      { ...row('Receipt number', r.receiptNumber), gapBefore: 18 },
      row('Paid on', `${paidAt} IST`),
      { text: `Amount paid:  ${amount}`, bold: true, size: 13, gapBefore: 6 },
      {
        ...row('Paid for', r.feeCode === BOOKING_FEE_CODE ? 'Booking fee' : r.feeCode),
        gapBefore: 6,
      },
      row('Booking ID', r.bookingId),
      row('Payment ID', r.paymentId),
      row('Payment method', method || null),
      row('Gateway reference', r.gatewayReference),
      row('Status', r.status),
    ];
    if (r.refundStatus) {
      lines.push({ ...row('Refund', r.refundStatus), gapBefore: 6 });
      if (r.refundedAt) lines.push(row('Refunded on', r.refundedAt.toISOString()));
    }
    return {
      fileName: `${r.receiptNumber}.pdf`,
      pdf: buildTextPdf(lines, `Receipt ${r.receiptNumber}`),
    };
  }

  async getMine(customerUserId: string, paymentId: string): Promise<PaymentView> {
    const payment = await this.repository.findById(paymentId);
    if (!payment || payment.customerUserId !== customerUserId) throw this.notFound();
    return this.view(payment);
  }

  // --- gateway webhook ---------------------------------------------------------------------------------------

  /** Authenticates the notification first; nothing in the body is looked at before the adapter accepted the signature. */
  async handleWebhook(
    rawBody: Buffer | undefined,
    headers: Record<string, string | undefined>,
  ): Promise<{ received: true }> {
    if (!rawBody || !this.provider.verifyWebhookSignature(rawBody, headers)) {
      throw new DomainException(
        PaymentErrorCode.INVALID_SIGNATURE,
        'The notification could not be authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const event = this.provider.parseWebhookEvent(rawBody, headers);
    if (!event) {
      throw new DomainException(
        ErrorCode.BAD_REQUEST,
        'Unsupported notification',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (event.kind === 'IGNORED') return { received: true };
    if (event.kind === 'REFUND') {
      await this.applyRefundReport(event);
      return { received: true };
    }
    await this.applyOutcome(
      event.providerOrderId,
      {
        providerPaymentId: event.providerPaymentId,
        outcome: event.outcome,
        amountMinor: event.amountMinor,
        currency: event.currency,
        method: event.method,
        methodDetail: event.methodDetail,
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
      },
      { source: 'webhook', eventId: event.eventId },
    );
    return { received: true };
  }

  // --- admin -------------------------------------------------------------------------------------------------

  async adminList(query: AdminPaymentListQuery): Promise<Page<AdminPaymentView>> {
    const { items, total } = await this.repository.list(
      { customerUserId: query.customerUserId, bookingId: query.bookingId, status: query.status },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((p) => this.adminView(p)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(paymentId: string): Promise<AdminPaymentView> {
    const payment = await this.repository.findById(paymentId);
    if (!payment) throw this.notFound();
    return this.adminView(payment);
  }

  /** Asks the gateway what really happened ("callback delayed: reconcile before the final state", FM-07). */
  async reconcile(paymentId: string, admin: PaymentActor): Promise<AdminPaymentView> {
    const payment = await this.repository.findById(paymentId);
    if (!payment) throw this.notFound();
    if (!payment.providerOrderId) {
      throw new DomainException(
        PaymentErrorCode.NOTHING_TO_RECONCILE,
        'No checkout was started for this payment yet',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.reconcileNow(paymentId, { actor: admin });
    return this.adminView((await this.repository.findById(paymentId))!);
  }

  /**
   * One authoritative check of a payment (or of its refund) against the gateway. Used by the admin action (`actor` set: provider
   * errors surface to the caller) and by the recovery worker (no actor: errors are recorded and retried with backoff). It never
   * converts an unknown payment into success without the gateway reporting it; it returns a stable note describing what was
   * verified. Safe to repeat and to run concurrently (every state change goes through the locked applyOutcome).
   */
  async reconcileNow(paymentId: string, opts: { actor?: PaymentActor } = {}): Promise<string> {
    const payment = await this.repository.findById(paymentId);
    if (!payment) return 'NOT_FOUND';
    if (payment.status === 'REFUND_PENDING') return this.reconcileRefund(payment, opts);
    if (payment.status !== 'PENDING' && payment.status !== 'FAILED') {
      await this.clearSchedule(payment.id);
      return 'NOTHING_TO_CHECK';
    }
    if (!payment.providerOrderId) {
      await this.clearSchedule(payment.id);
      return 'NO_ORDER';
    }
    let remote: ProviderPayment[];
    try {
      remote = await this.provider.findPaymentsForOrder(payment.providerOrderId);
    } catch (error) {
      return this.checkFailed(payment, error, opts, 'RECONCILIATION_EXHAUSTED');
    }
    const captured = remote.filter((r) => r.outcome === 'SUCCEEDED');
    const latest =
      remote.find((r) => r.providerPaymentId === payment.providerPaymentId) ?? remote.at(-1);
    // A FAILED payment is only re-opened by evidence of success; re-applying its failure would just add audit noise.
    const toApply =
      captured.length > 0 ? captured : latest && payment.status !== 'FAILED' ? [latest] : [];
    for (const report of toApply) {
      await this.applyOutcome(
        payment.providerOrderId,
        {
          providerPaymentId: report.providerPaymentId,
          outcome: report.outcome,
          amountMinor: report.amountMinor,
          currency: report.currency,
          method: report.method,
          methodDetail: report.methodDetail,
          errorCode: report.errorCode,
          errorDescription: report.errorDescription,
        },
        { source: opts.actor ? 'admin-reconciliation' : 'auto-reconciliation', actor: opts.actor },
      );
    }
    const seen = toApply[0] ?? latest;
    const note = seen ? `GATEWAY_${seen.outcome}` : 'NO_GATEWAY_ACTIVITY';
    // Evidence of an unfinished payment (something exists at the gateway but is not final) is worth a person's attention if the
    // checks run out; an order nobody ever tried to pay is not.
    const concern =
      payment.status === 'PENDING' &&
      remote.length > 0 &&
      !remote.some((r) => r.outcome !== 'PENDING');
    await this.markChecked(payment.id, note, concern, 'RECONCILIATION_EXHAUSTED', opts.actor);
    return note;
  }

  /** Full refund of a succeeded payment (partial refunds and who may refund are open, Q-17/Q-21). Repeating is safe. */
  async refund(paymentId: string, dto: RefundDto, admin: PaymentActor): Promise<AdminPaymentView> {
    const payment = await this.repository.transaction(async (tx) => {
      const locked = await this.repository.lock(paymentId, tx);
      if (!locked) throw this.notFound();
      if (!['SUCCEEDED', 'REFUND_PENDING', 'REFUND_FAILED'].includes(locked.status)) {
        throw new DomainException(
          PaymentErrorCode.INVALID_PAYMENT_STATE,
          `A payment that is ${locked.status} cannot be refunded`,
          HttpStatus.CONFLICT,
        );
      }
      if (locked.status !== 'REFUND_PENDING') {
        await this.repository.update(
          locked.id,
          {
            status: 'REFUND_PENDING',
            refundReason: dto.reason,
            refundedByUserId: admin.userId,
            refundProviderId: null,
            // Scheduled before the gateway is called: if this process dies right after, the recovery worker finishes the job.
            reconcileAttempts: 0,
            reconcileNextAt: new Date(Date.now() + RECOVERY.firstCheckDelayMs),
            reconcileClaimedUntil: null,
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'payment.refund_request',
            entityType: 'payment',
            entityId: locked.id,
            actorId: admin.userId,
            actorRole: admin.roles.join(',') || null,
            metadata: {
              from: locked.status,
              to: 'REFUND_PENDING',
              amountMinor: locked.amountMinor,
            },
          },
          tx,
        );
      }
      return locked;
    });
    // No transaction is held across the gateway call.
    let refund: ProviderRefund;
    try {
      refund = await this.initiateRefund(payment);
    } catch (error) {
      throw this.providerFailure(error, PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE);
    }
    await this.repository.transaction(async (tx) => {
      const locked = (await this.repository.lock(payment.id, tx))!;
      await this.applyRefundLocked(locked, refund, { source: 'admin', actor: admin }, tx);
    });
    return this.adminView((await this.repository.findById(payment.id))!);
  }

  /**
   * Payments created in a date range as CSV (invoice/reference export, PRD 7). Capped at EXPORT_MAX_ROWS (413 beyond it: narrow the
   * range) and audited. No customer name, mobile or card data is included - ids and gateway references only. Every cell that could be
   * read as a spreadsheet formula is neutralised.
   */
  async exportCsv(range: { from: string; to: string }, admin: PaymentActor): Promise<string> {
    if (!isRealDate(range.from) || !isRealDate(range.to) || range.to < range.from) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'to',
            messages: ['from and to must be real dates and to must not precede from'],
          },
        ],
      );
    }
    const start = new Date(`${range.from}T00:00:00+05:30`);
    const end = new Date(new Date(`${range.to}T00:00:00+05:30`).getTime() + 86_400_000);
    if (end.getTime() - start.getTime() > 366 * 86_400_000) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'to', messages: ['the range is limited to 366 days'] }],
      );
    }
    const rows = await this.repository.listForExport(start, end, EXPORT_MAX_ROWS);
    if (rows.length > EXPORT_MAX_ROWS) {
      throw new DomainException(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `More than ${EXPORT_MAX_ROWS} payments in this range: choose a shorter range`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    await this.audit.record({
      action: 'payment.export',
      entityType: 'payment',
      actorId: admin.userId,
      actorRole: admin.roles.join(',') || null,
      metadata: { from: range.from, to: range.to, rows: rows.length },
    });
    const header = [
      'payment_id',
      'booking_id',
      'status',
      'amount_minor',
      'currency',
      'receipt_number',
      'provider_order_id',
      'provider_payment_id',
      'paid_at',
      'refund_status',
      'refunded_at',
      'created_at',
    ];
    const lines = rows.map((p) =>
      [
        p.id,
        p.bookingId,
        p.status,
        p.amountMinor,
        p.currency,
        p.receiptNumber,
        p.providerOrderId,
        p.providerPaymentId,
        p.paidAt?.toISOString(),
        p.status.startsWith('REFUND') ? p.status : '',
        p.refundedAt?.toISOString(),
        p.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  // --- exceptions (admin) -------------------------------------------------------------------------------------

  async listExceptions(query: {
    status?: 'OPEN' | 'RESOLVED';
    kind?: string;
    paymentId?: string;
    page: number;
    limit: number;
  }): Promise<Page<ExceptionView>> {
    const { items, total } = await this.repository.listExceptions(
      {
        status: query.status,
        kind: query.kind as NewPaymentException['kind'] | undefined,
        paymentId: query.paymentId,
      },
      skipFor(query),
      query.limit,
    );
    return {
      data: items,
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** A person records what they did about a money problem. It moves no money and changes no payment: it closes the alert. */
  async resolveException(
    exceptionId: string,
    note: string,
    admin: PaymentActor,
  ): Promise<ExceptionView> {
    await this.repository.transaction(async (tx) => {
      const existing = await this.repository.findException(exceptionId, tx);
      if (!existing) {
        throw new DomainException(
          PaymentErrorCode.EXCEPTION_NOT_FOUND,
          'Payment exception not found',
          HttpStatus.NOT_FOUND,
        );
      }
      const resolved = await this.repository.resolveException(exceptionId, admin.userId, note, tx);
      if (!resolved) {
        throw new DomainException(
          PaymentErrorCode.EXCEPTION_NOT_OPEN,
          'This exception is already resolved',
          HttpStatus.CONFLICT,
        );
      }
      await this.alerts.autoResolve(`PAYMENT_EXCEPTION:${exceptionId}`, 'resolved by a person', tx);
      await this.audit.record(
        {
          action: 'payment.exception_resolved',
          entityType: 'payment_exception',
          entityId: exceptionId,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: {
            kind: existing.kind,
            paymentId: existing.paymentId,
            bookingId: existing.bookingId,
          },
        },
        tx,
      );
    });
    return (await this.repository.findException(exceptionId))!;
  }

  recoverySummary(): ReturnType<PaymentRepository['recoverySummary']> {
    return this.repository.recoverySummary();
  }

  // --- shared with the recovery service -------------------------------------------------------------------------

  /**
   * Records a money problem once (open or resolved, never duplicated), audits it and alerts staff through the outbox - all in the
   * caller's transaction, so the alert exists if and only if the surrounding change committed.
   */
  async raiseException(input: NewPaymentException, tx: Prisma.TransactionClient): Promise<void> {
    const id = await this.repository.createException(input, tx);
    if (!id) return;
    await this.audit.record(
      {
        action: 'payment.exception_raised',
        entityType: 'payment_exception',
        entityId: id,
        actorId: null,
        metadata: {
          kind: input.kind,
          paymentId: input.paymentId ?? null,
          bookingId: input.bookingId ?? null,
          bookingStatus: input.bookingStatus ?? null,
          paymentStatus: input.paymentStatus ?? null,
          amountMinor: input.amountMinor ?? null,
          requiredAction: input.requiredAction,
        },
      },
      tx,
    );
    // The in-system alert inbox is the reliable channel: it needs no notification template to exist.
    await this.alerts.raise(
      {
        dedupeKey: `PAYMENT_EXCEPTION:${id}`,
        type: 'PAYMENT_EXCEPTION',
        severity: 'CRITICAL',
        title: `Money problem: ${input.kind}`,
        requiredPermission: PermissionCode.PAYMENT_VIEW,
        entityType: 'payment_exception',
        entityId: id,
        detail: {
          kind: input.kind,
          paymentId: input.paymentId ?? null,
          requiredAction: input.requiredAction,
        },
      },
      tx,
    );
    await this.outbox.notify(
      {
        event: NotificationEvent.PAYMENT_EXCEPTION_ALERT,
        recipients: await this.repository.alertRecipientIds(tx),
        params: { exceptionId: id, kind: input.kind, paymentId: input.paymentId ?? '' },
      },
      tx,
    );
  }

  // --- internals ---------------------------------------------------------------------------------------------

  private async openOrder(payment: PaymentRecord): Promise<PaymentRecord> {
    try {
      const order = await this.provider.createOrder({
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        reference: payment.id,
        idempotencyKey: payment.id,
      });
      await this.repository.transaction(async (tx) => {
        const locked = (await this.repository.lock(payment.id, tx))!;
        if (locked.providerOrderId) return;
        await this.repository.update(
          locked.id,
          {
            status: 'PENDING',
            providerOrderId: order.providerOrderId,
            checkoutPayload: order.checkoutPayload,
            // The first authoritative check is booked now, so a lost callback is found even if nothing else ever happens.
            reconcileAttempts: 0,
            reconcileNextAt: new Date(Date.now() + RECOVERY.firstCheckDelayMs),
          },
          tx,
        );
      });
    } catch (error) {
      throw this.providerFailure(error, PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE);
    }
    return (await this.repository.findById(payment.id))!;
  }

  /**
   * THE place where a gateway outcome becomes our state. Serialised by the booking and payment row locks (booking first); a
   * notification is recorded once (duplicates are acknowledged and ignored); the amount and currency must equal what we asked
   * for; terminal states never change. Every case that cannot be settled by a rule becomes an exception for a person.
   */
  private async applyOutcome(
    providerOrderId: string,
    report: GatewayReport,
    context: ApplyContext,
  ): Promise<Applied> {
    const known = await this.repository.findByProviderOrderId(providerOrderId);
    return this.repository.transaction(async (tx) => {
      if (known) await this.bookings.lockBooking(known.bookingId, tx);
      const payment = known ? await this.repository.lock(known.id, tx) : null;
      const eventId = context.eventId;
      if (eventId) {
        const fresh = await this.repository.recordEvent(
          {
            providerEventId: eventId,
            paymentId: payment?.id ?? null,
            outcome: report.outcome,
            applied: false,
            note: payment ? 'RECEIVED' : 'UNKNOWN_ORDER',
            eventKind: 'PAYMENT',
            providerOrderId,
            providerPaymentId: report.providerPaymentId,
            amountMinor: report.amountMinor,
            currency: report.currency,
          },
          tx,
        );
        if (!fresh) return 'DUPLICATE';
      }
      const resultEventId = eventId ?? context.replayEventId;
      const finish = async (result: Applied, note: string): Promise<Applied> => {
        if (resultEventId) {
          await this.repository.setEventResult(
            resultEventId,
            { applied: result === 'APPLIED', note },
            tx,
          );
        }
        if (result !== 'APPLIED' && payment) {
          await this.audit.record(
            {
              action: 'payment.report_ignored',
              entityType: 'payment',
              entityId: payment.id,
              actorId: context.actor?.userId ?? null,
              metadata: {
                source: context.source,
                reported: report.outcome,
                reason: note,
                status: payment.status,
              },
            },
            tx,
          );
        }
        return result;
      };
      if (!payment) return finish('IGNORED', 'UNKNOWN_ORDER');
      const exceptionBase = {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        paymentStatus: payment.status,
        currency: payment.currency,
        providerOrderId,
        providerPaymentId: report.providerPaymentId,
      };
      if (report.amountMinor !== payment.amountMinor) {
        if (report.outcome === 'SUCCEEDED') {
          await this.raiseException(
            {
              ...exceptionBase,
              dedupeKey: `AMOUNT_MISMATCH:${payment.id}:${report.providerPaymentId}`,
              kind: 'AMOUNT_MISMATCH',
              amountMinor: report.amountMinor,
              requiredAction: 'VERIFY_WITH_GATEWAY_AND_REFUND_OR_RESOLVE',
              details: { expectedMinor: payment.amountMinor, reportedMinor: report.amountMinor },
            },
            tx,
          );
        }
        return finish('MISMATCH', 'AMOUNT_MISMATCH');
      }
      if (report.currency && report.currency !== payment.currency) {
        if (report.outcome === 'SUCCEEDED') {
          await this.raiseException(
            {
              ...exceptionBase,
              dedupeKey: `CURRENCY_MISMATCH:${payment.id}:${report.providerPaymentId}`,
              kind: 'CURRENCY_MISMATCH',
              amountMinor: report.amountMinor,
              requiredAction: 'VERIFY_WITH_GATEWAY_AND_REFUND_OR_RESOLVE',
              details: { expected: payment.currency, reported: report.currency },
            },
            tx,
          );
        }
        return finish('MISMATCH', 'CURRENCY_MISMATCH');
      }
      if (
        payment.providerPaymentId &&
        payment.providerPaymentId !== report.providerPaymentId &&
        ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'].includes(payment.status)
      ) {
        if (report.outcome === 'SUCCEEDED') {
          // A second successful payment on an order that is already paid: the customer was charged twice.
          await this.raiseException(
            {
              ...exceptionBase,
              dedupeKey: `DUPLICATE_PAYMENT:${payment.id}:${report.providerPaymentId}`,
              kind: 'DUPLICATE_PAYMENT',
              amountMinor: report.amountMinor,
              requiredAction: 'REFUND_DUPLICATE_AT_GATEWAY_OR_RESOLVE',
              details: { firstProviderPaymentId: payment.providerPaymentId },
            },
            tx,
          );
        }
        return finish('IGNORED', 'OTHER_PAYMENT_FOR_PAID_ORDER');
      }
      // A gateway order can see a failed attempt and then a successful one (UPI fails, card works): a late success on a FAILED
      // payment is real money and is accepted, unless the customer already started a newer payment for the booking.
      const lateSuccess = payment.status === 'FAILED' && report.outcome === 'SUCCEEDED';
      if (payment.status !== 'PENDING' && payment.status !== 'CREATED' && !lateSuccess) {
        return finish('IGNORED', `ALREADY_${payment.status}`);
      }
      if (lateSuccess) {
        const other = await this.repository.findOpenForBooking(payment.bookingId, tx);
        if (other && other.id !== payment.id) {
          await this.raiseException(
            {
              ...exceptionBase,
              dedupeKey: `DUPLICATE_PAYMENT:${payment.id}:${report.providerPaymentId}`,
              kind: 'DUPLICATE_PAYMENT',
              amountMinor: report.amountMinor,
              requiredAction: 'REFUND_DUPLICATE_AT_GATEWAY_OR_RESOLVE',
              details: { supersededBy: other.id },
            },
            tx,
          );
          return finish('IGNORED', 'SUPERSEDED_ORDER');
        }
      }
      if (report.outcome === 'PENDING') {
        await this.repository.update(
          payment.id,
          { providerPaymentId: report.providerPaymentId },
          tx,
        );
        return finish('IGNORED', 'STILL_PENDING');
      }
      if (report.outcome === 'FAILED') {
        await this.repository.update(
          payment.id,
          {
            status: 'FAILED',
            providerPaymentId: report.providerPaymentId,
            failureReason: report.errorDescription ?? 'The payment did not go through',
            failureCode: report.errorCode ?? null,
            ...(report.method ? { paymentMethod: report.method } : {}),
            ...(report.methodDetail ? { paymentMethodDetail: report.methodDetail } : {}),
            // A short tail of checks: another attempt on the same order may still succeed (UPI fails, card works).
            reconcileAttempts: 0,
            reconcileNextAt: new Date(Date.now() + RECOVERY.tailFirstDelayMs),
            reconcileClaimedUntil: null,
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'payment.failed',
            entityType: 'payment',
            entityId: payment.id,
            actorId: context.actor?.userId ?? null,
            metadata: { from: payment.status, to: 'FAILED', source: context.source },
          },
          tx,
        );
        await this.outbox.notify(
          {
            event: NotificationEvent.PAYMENT_FAILED,
            recipients: [payment.customerUserId],
            params: { bookingId: payment.bookingId, paymentId: payment.id },
          },
          tx,
        );
        return finish('APPLIED', 'FAILED');
      }
      const receiptNumber = this.receipt();
      await this.repository.update(
        payment.id,
        {
          status: 'SUCCEEDED',
          providerPaymentId: report.providerPaymentId,
          ...(report.method ? { paymentMethod: report.method } : {}),
          ...(report.methodDetail ? { paymentMethodDetail: report.methodDetail } : {}),
          failureCode: null,
          paidAt: new Date(),
          receiptNumber,
          reconcileNextAt: null,
          reconcileClaimedUntil: null,
        },
        tx,
      );
      const confirmed = await this.bookings.applyPaymentSucceeded(payment.bookingId, tx);
      await this.audit.record(
        {
          action: 'payment.succeeded',
          entityType: 'payment',
          entityId: payment.id,
          actorId: context.actor?.userId ?? null,
          metadata: {
            from: payment.status,
            to: 'SUCCEEDED',
            source: context.source,
            bookingConfirmed: confirmed,
          },
        },
        tx,
      );
      if (confirmed) {
        await this.outbox.notify(
          {
            event: NotificationEvent.PAYMENT_SUCCEEDED,
            recipients: [payment.customerUserId],
            params: { bookingId: payment.bookingId, paymentId: payment.id, receiptNumber },
          },
          tx,
        );
        return finish('APPLIED', 'SUCCEEDED');
      }
      // Money arrived for a booking that is no longer waiting for payment (typically cancelled while checkout was open). It is
      // NOT an ordinary successful booking payment: it is recorded as a financial exception for a person to settle.
      await this.raiseException(
        {
          ...exceptionBase,
          dedupeKey: `LATE_PAYMENT_BOOKING_NOT_PENDING:${payment.id}`,
          kind: 'LATE_PAYMENT_BOOKING_NOT_PENDING',
          bookingStatus: await this.bookings.statusInTx(payment.bookingId, tx),
          paymentStatus: 'SUCCEEDED',
          amountMinor: payment.amountMinor,
          requiredAction: 'REVIEW_REFUND_OR_RESOLVE',
          details: { source: context.source, receiptNumber },
        },
        tx,
      );
      await this.outbox.notify(
        {
          event: NotificationEvent.PAYMENT_UNDER_REVIEW,
          recipients: [payment.customerUserId],
          params: { bookingId: payment.bookingId, paymentId: payment.id },
        },
        tx,
      );
      return finish('APPLIED', 'SUCCEEDED_BOOKING_NOT_PENDING');
    });
  }

  /** Re-applies webhooks that arrived before their order existed. Returns how many were applied or settled. */
  async replayUnknownOrderEvent(event: {
    providerEventId: string;
    outcome: string;
    providerOrderId: string;
    providerPaymentId: string;
    amountMinor: number;
    currency: string | null;
  }): Promise<boolean> {
    const payment = await this.repository.findByProviderOrderId(event.providerOrderId);
    if (!payment) return false;
    await this.applyOutcome(
      event.providerOrderId,
      {
        providerPaymentId: event.providerPaymentId,
        outcome: event.outcome as ProviderPaymentOutcome,
        amountMinor: event.amountMinor,
        currency: event.currency ?? undefined,
      },
      { source: 'webhook-replay', replayEventId: event.providerEventId },
    );
    return true;
  }

  // --- refunds -----------------------------------------------------------------------------------------------

  /**
   * Asks the gateway to refund, adopting a refund it already holds (a creation response that was lost) instead of creating
   * a second one. A new refund after earlier FAILED ones gets a key derived from how many failed, so a repeat never collides
   * with the failed attempt and a retry of the same attempt never duplicates.
   */
  private async initiateRefund(payment: PaymentRecord): Promise<ProviderRefund> {
    const existing = await this.provider.findRefundsForPayment(payment.providerPaymentId!);
    const live = existing.find((r) => r.outcome !== 'FAILED');
    if (live) return live;
    const failed = existing.filter((r) => r.outcome === 'FAILED').length;
    return this.provider.refund({
      providerPaymentId: payment.providerPaymentId!,
      amountMinor: payment.amountMinor,
      idempotencyKey: failed === 0 ? `refund-${payment.id}` : `refund-${payment.id}-f${failed}`,
    });
  }

  /** Authoritative refund state is only ever written here, from a gateway answer; "accepted" (PENDING) never means refunded. */
  private async applyRefundLocked(
    locked: PaymentRecord,
    refund: ProviderRefund,
    context: { source: string; actor?: PaymentActor },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (locked.status !== 'REFUND_PENDING') return;
    if (refund.outcome === 'PENDING') {
      await this.repository.update(locked.id, { refundProviderId: refund.providerRefundId }, tx);
      return;
    }
    const done = refund.outcome === 'SUCCEEDED';
    await this.repository.update(
      locked.id,
      {
        ...(done
          ? { status: 'REFUNDED' as const, refundedAt: new Date() }
          : { status: 'REFUND_FAILED' as const }),
        refundProviderId: refund.providerRefundId,
        reconcileNextAt: null,
        reconcileClaimedUntil: null,
      },
      tx,
    );
    await this.audit.record(
      {
        action: done ? 'payment.refunded' : 'payment.refund_failed',
        entityType: 'payment',
        entityId: locked.id,
        actorId: context.actor?.userId ?? null,
        actorRole: context.actor?.roles.join(',') || null,
        metadata: {
          from: 'REFUND_PENDING',
          to: done ? 'REFUNDED' : 'REFUND_FAILED',
          source: context.source,
        },
      },
      tx,
    );
  }

  private async reconcileRefund(
    payment: PaymentRecord,
    opts: { actor?: PaymentActor },
  ): Promise<string> {
    let refund: ProviderRefund;
    try {
      refund = payment.refundProviderId
        ? await this.provider.getRefund(payment.refundProviderId)
        : await this.initiateRefund(payment);
    } catch (error) {
      return this.checkFailed(payment, error, opts, 'REFUND_STUCK');
    }
    await this.repository.transaction(async (tx) => {
      const locked = (await this.repository.lock(payment.id, tx))!;
      await this.applyRefundLocked(
        locked,
        refund,
        { source: opts.actor ? 'admin-reconciliation' : 'auto-reconciliation', actor: opts.actor },
        tx,
      );
    });
    const note = `REFUND_${refund.outcome}`;
    await this.markChecked(
      payment.id,
      note,
      refund.outcome === 'PENDING',
      'REFUND_STUCK',
      opts.actor,
    );
    return note;
  }

  /** A refund notification from the gateway. Authenticated and deduplicated like payment notifications. */
  private async applyRefundReport(event: ProviderWebhookEvent): Promise<void> {
    const known = await this.repository.findByProviderPaymentId(event.providerPaymentId);
    await this.repository.transaction(async (tx) => {
      if (known) await this.bookings.lockBooking(known.bookingId, tx);
      const payment = known ? await this.repository.lock(known.id, tx) : null;
      const fresh = await this.repository.recordEvent(
        {
          providerEventId: event.eventId,
          paymentId: payment?.id ?? null,
          outcome: event.outcome,
          applied: false,
          note: payment ? 'RECEIVED' : 'UNKNOWN_PAYMENT',
          eventKind: 'REFUND',
          providerPaymentId: event.providerPaymentId,
          providerRefundId: event.providerRefundId,
          amountMinor: event.amountMinor,
        },
        tx,
      );
      if (!fresh) return;
      let applied = false;
      let note = payment ? `ALREADY_${payment.status}` : 'UNKNOWN_PAYMENT';
      if (payment?.status === 'REFUND_PENDING') {
        await this.applyRefundLocked(
          payment,
          { providerRefundId: event.providerRefundId ?? '', outcome: event.outcome },
          { source: 'webhook' },
          tx,
        );
        applied = event.outcome !== 'PENDING';
        note = applied ? 'REFUND_APPLIED' : 'STILL_PENDING';
      } else if (payment?.status === 'SUCCEEDED' && event.outcome !== 'FAILED') {
        // The gateway is refunding money we never asked to refund (e.g. done by hand in its dashboard).
        await this.raiseException(
          {
            paymentId: payment.id,
            bookingId: payment.bookingId,
            paymentStatus: payment.status,
            amountMinor: event.amountMinor,
            currency: payment.currency,
            providerPaymentId: payment.providerPaymentId,
            dedupeKey: `REFUND_NOT_REQUESTED:${payment.id}:${event.providerRefundId ?? event.eventId}`,
            kind: 'REFUND_NOT_REQUESTED',
            requiredAction: 'CONFIRM_REFUND_AND_ALIGN_RECORDS',
            details: { providerRefundId: event.providerRefundId ?? null, outcome: event.outcome },
          },
          tx,
        );
        note = 'REFUND_NOT_REQUESTED';
      }
      await this.repository.setEventResult(event.eventId, { applied, note }, tx);
    });
  }

  // --- recovery scheduling ---------------------------------------------------------------------------------

  private async clearSchedule(paymentId: string): Promise<void> {
    await this.repository.transaction((tx) =>
      this.repository.update(paymentId, { reconcileNextAt: null, reconcileClaimedUntil: null }, tx),
    );
  }

  /**
   * Records that a check happened and books the next one with bounded exponential backoff and jitter. When the checks run out,
   * a payment the gateway still reports as unfinished (or a refund with no final answer) is escalated to a person; nothing is
   * ever assumed. Done under the payment lock so a webhook that settled the payment meanwhile wins.
   */
  private async markChecked(
    paymentId: string,
    note: string,
    concern: boolean,
    exhaustedKind: 'RECONCILIATION_EXHAUSTED' | 'REFUND_STUCK',
    actor?: PaymentActor,
  ): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const payment = await this.repository.lock(paymentId, tx);
      if (!payment) return;
      if (
        FINAL_FOR_RECOVERY.has(payment.status) ||
        !['PENDING', 'FAILED', 'REFUND_PENDING'].includes(payment.status)
      ) {
        await this.repository.update(
          paymentId,
          {
            reconcileNextAt: null,
            reconcileClaimedUntil: null,
            reconcileLastAt: new Date(),
            reconcileLastNote: note,
          },
          tx,
        );
        return;
      }
      if (actor) {
        // A manual check does not consume the automatic budget.
        await this.repository.update(
          paymentId,
          { reconcileClaimedUntil: null, reconcileLastAt: new Date(), reconcileLastNote: note },
          tx,
        );
        return;
      }
      const attempts = payment.reconcileAttempts + 1;
      const max = payment.status === 'FAILED' ? RECOVERY.failedTailAttempts : RECOVERY.maxAttempts;
      const exhausted = attempts >= max;
      await this.repository.update(
        paymentId,
        {
          reconcileAttempts: attempts,
          reconcileNextAt: exhausted ? null : new Date(Date.now() + nextCheckDelayMs(attempts)),
          reconcileClaimedUntil: null,
          reconcileLastAt: new Date(),
          reconcileLastNote: note,
        },
        tx,
      );
      if (exhausted && concern) {
        await this.raiseException(
          {
            dedupeKey: `${exhaustedKind}:${payment.id}`,
            kind: exhaustedKind,
            paymentId: payment.id,
            bookingId: payment.bookingId,
            paymentStatus: payment.status,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            providerOrderId: payment.providerOrderId,
            providerPaymentId: payment.providerPaymentId,
            requiredAction: 'CHECK_GATEWAY_DASHBOARD_AND_RECONCILE_MANUALLY',
            details: { attempts, lastNote: note },
          },
          tx,
        );
      }
    });
  }

  /** A failed gateway call during a check: manual checks surface it, automatic checks record it and retry later. */
  private async checkFailed(
    payment: PaymentRecord,
    error: unknown,
    opts: { actor?: PaymentActor },
    exhaustedKind: 'RECONCILIATION_EXHAUSTED' | 'REFUND_STUCK',
  ): Promise<string> {
    if (opts.actor)
      throw this.providerFailure(error, PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE);
    if (!(error instanceof ProviderError)) throw error;
    this.logger.warn(
      `Payment check failed (${error.retryable ? 'temporary' : 'rejected'}): payment ${payment.id}`,
    );
    const note = error.retryable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED';
    await this.markChecked(payment.id, note, true, exhaustedKind);
    return note;
  }

  private receipt(): string {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `RCPT-${day}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  private view(payment: PaymentRecord): PaymentView {
    const refund = ['REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'].includes(payment.status)
      ? (payment.status as 'REFUND_PENDING' | 'REFUNDED' | 'REFUND_FAILED')
      : null;
    return {
      id: payment.id,
      bookingId: payment.bookingId,
      status: payment.status,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      receiptNumber: payment.receiptNumber,
      paidAt: payment.paidAt,
      refundStatus: refund,
      refundedAt: payment.refundedAt,
      createdAt: payment.createdAt,
      paymentMethod: payment.paymentMethod,
      paymentMethodDetail: payment.paymentMethodDetail,
      gatewayReference: payment.providerPaymentId,
      failureCode: payment.status === 'FAILED' ? payment.failureCode : null,
      failureReason: payment.status === 'FAILED' ? payment.failureReason : null,
    };
  }

  /** The typed checkout contract; payloads stored before `gateway` existed are recognised by their key. */
  private checkout(payload: Record<string, unknown> | null): CheckoutView | null {
    if (!payload || typeof payload.orderId !== 'string') return null;
    const keyId = typeof payload.keyId === 'string' ? payload.keyId : null;
    return {
      gateway: typeof payload.gateway === 'string' ? payload.gateway : keyId ? 'razorpay' : 'fake',
      keyId,
      orderId: payload.orderId,
      amount: typeof payload.amount === 'number' ? payload.amount : 0,
      currency: typeof payload.currency === 'string' ? payload.currency : 'INR',
    };
  }

  private adminView(payment: PaymentRecord): AdminPaymentView {
    return {
      ...this.view(payment),
      customerUserId: payment.customerUserId,
      feeCode: payment.feeCode,
      providerOrderId: payment.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      failureReason: payment.failureReason,
      refundReason: payment.refundReason,
      refundedByUserId: payment.refundedByUserId,
    };
  }

  private providerFailure(error: unknown, code: string): unknown {
    if (error instanceof ProviderError) {
      return new DomainException(
        code,
        error.retryable || code === PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE
          ? 'The payment gateway is not available right now'
          : 'The payment could not be verified',
        code === PaymentErrorCode.PAYMENT_VERIFICATION_FAILED
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return error;
  }

  private notFound(): DomainException {
    return new DomainException(
      PaymentErrorCode.PAYMENT_NOT_FOUND,
      'Payment not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private bookingNotFound(): DomainException {
    return new DomainException('BOOKING_NOT_FOUND', 'Booking not found', HttpStatus.NOT_FOUND);
  }
}

export type ExceptionView = PaymentExceptionRecord;
