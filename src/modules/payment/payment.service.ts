import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderPaymentOutcome,
} from '../../integrations/payments/payment-provider.interface';
import { ProviderError } from '../../integrations/provider-error';
import { BookingService } from '../booking/booking.service';
import {
  AdminPaymentListQuery,
  AdminPaymentView,
  BOOKING_FEE_CODE,
  CreatePaymentResponse,
  FeeView,
  PaymentListQuery,
  PaymentView,
  RefundDto,
  SetFeeDto,
  VerifyPaymentDto,
} from './dto/payment.dto';
import { FeeRecord, PaymentRecord, PaymentRepository } from './payment.repository';

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
} as const;

export interface PaymentActor {
  userId: string;
  roles: string[];
}

type Applied = 'APPLIED' | 'DUPLICATE' | 'IGNORED' | 'MISMATCH';

/**
 * Payments (SRS 3.6, FRD FM-07). Owns the payment tables and the payment state machine; the gateway is reached only through
 * the PaymentProvider abstraction (no vendor is selected, Q-08). State changes come ONLY from the gateway (a verified
 * webhook, a server-side verification of a client report, or a reconciliation read) - never from what a client claims.
 * Booking is told about success through its own contract inside the same transaction.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly bookings: BookingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
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
      const fee = await this.repository.findFee(BOOKING_FEE_CODE);
      if (!fee || !fee.isActive) {
        throw new DomainException(
          PaymentErrorCode.FEE_NOT_CONFIGURED,
          'The booking fee has not been configured',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      try {
        payment = await this.repository.transaction(async (tx) => {
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
    return { ...this.view(payment), checkout: payment.checkoutPayload };
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
      },
      { source: 'client-verification' },
    );
    return this.view((await this.repository.findById(paymentId))!);
  }

  async listMine(customerUserId: string, query: PaymentListQuery): Promise<Page<PaymentView>> {
    const { items, total } = await this.repository.list(
      { customerUserId, status: query.status },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((p) => this.view(p)),
      meta: { page: query.page, limit: query.limit, total },
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
    const event = this.provider.parseWebhookEvent(rawBody);
    if (!event) {
      throw new DomainException(
        ErrorCode.BAD_REQUEST,
        'Unsupported notification',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.applyOutcome(
      event.providerOrderId,
      {
        providerPaymentId: event.providerPaymentId,
        outcome: event.outcome,
        amountMinor: event.amountMinor,
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
    if (!payment.providerOrderId || !payment.providerPaymentId) {
      throw new DomainException(
        PaymentErrorCode.NOTHING_TO_RECONCILE,
        'The gateway has not reported a payment for this order yet',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    let remote: ProviderPayment;
    try {
      remote = await this.provider.getPayment(payment.providerPaymentId);
    } catch (error) {
      throw this.providerFailure(error, PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE);
    }
    await this.applyOutcome(
      payment.providerOrderId,
      {
        providerPaymentId: remote.providerPaymentId,
        outcome: remote.outcome,
        amountMinor: remote.amountMinor,
      },
      { source: 'reconciliation', actor: admin },
    );
    return this.adminView((await this.repository.findById(paymentId))!);
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
          { status: 'REFUND_PENDING', refundReason: dto.reason, refundedByUserId: admin.userId },
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
    let outcome: ProviderPaymentOutcome;
    let refundId: string;
    try {
      const refund = await this.provider.refund({
        providerPaymentId: payment.providerPaymentId!,
        amountMinor: payment.amountMinor,
        idempotencyKey: `refund-${payment.id}`,
      });
      outcome = refund.outcome;
      refundId = refund.providerRefundId;
    } catch (error) {
      throw this.providerFailure(error, PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE);
    }
    await this.repository.transaction(async (tx) => {
      const locked = (await this.repository.lock(payment.id, tx))!;
      if (locked.status !== 'REFUND_PENDING') return;
      if (outcome === 'PENDING') return;
      const done = outcome === 'SUCCEEDED';
      await this.repository.update(
        locked.id,
        done
          ? { status: 'REFUNDED', refundProviderId: refundId, refundedAt: new Date() }
          : { status: 'REFUND_FAILED', refundProviderId: refundId },
        tx,
      );
      await this.audit.record(
        {
          action: done ? 'payment.refunded' : 'payment.refund_failed',
          entityType: 'payment',
          entityId: locked.id,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { from: 'REFUND_PENDING', to: done ? 'REFUNDED' : 'REFUND_FAILED' },
        },
        tx,
      );
    });
    return this.adminView((await this.repository.findById(payment.id))!);
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
   * THE place where a gateway outcome becomes our state. Serialised by the payment row lock; a notification is recorded once
   * (duplicates are acknowledged and ignored); the amount must equal what we asked for; terminal states never change.
   */
  private async applyOutcome(
    providerOrderId: string,
    report: { providerPaymentId: string; outcome: ProviderPaymentOutcome; amountMinor: number },
    context: { source: string; eventId?: string; actor?: PaymentActor },
  ): Promise<Applied> {
    const known = await this.repository.findByProviderOrderId(providerOrderId);
    return this.repository.transaction(async (tx) => {
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
          },
          tx,
        );
        if (!fresh) return 'DUPLICATE';
      }
      const finish = async (result: Applied, note: string): Promise<Applied> => {
        if (eventId) {
          await this.repository.setEventResult(
            eventId,
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
      if (report.amountMinor !== payment.amountMinor) return finish('MISMATCH', 'AMOUNT_MISMATCH');
      if (
        payment.providerPaymentId &&
        payment.providerPaymentId !== report.providerPaymentId &&
        payment.status === 'SUCCEEDED'
      ) {
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
        if (other && other.id !== payment.id) return finish('IGNORED', 'SUPERSEDED_ORDER');
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
            failureReason: 'the gateway reported a failure',
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
          paidAt: new Date(),
          receiptNumber,
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
      await this.outbox.notify(
        {
          event: NotificationEvent.PAYMENT_SUCCEEDED,
          recipients: [payment.customerUserId],
          params: { bookingId: payment.bookingId, paymentId: payment.id, receiptNumber },
        },
        tx,
      );
      return finish('APPLIED', confirmed ? 'SUCCEEDED' : 'SUCCEEDED_BOOKING_NOT_PENDING');
    });
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
