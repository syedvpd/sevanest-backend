import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { AuditService } from '../../common/audit/audit.service';
import type { Prisma } from '../../generated/prisma/client';
import { BookingLifecycleHooks, type BookingHook } from '../booking/booking-hooks';
import { BookingService } from '../booking/booking.service';
import { BOOKING_FEE_CODE } from './dto/payment.dto';
import { RECOVERY } from './payment-recovery.constants';
import { PaymentRepository, type PaymentRecord } from './payment.repository';
import { PaymentService } from './payment.service';

export interface RecoveryRun {
  claimed: number;
  checked: number;
  failed: number;
  replayed: number;
  escalated: number;
  flaggedCancelled: number;
}

/**
 * Booking cancellation x payment, and the background recovery that does not depend on any single request or callback.
 *
 * Cancellation hook (inside the cancelling transaction, booking row already locked):
 *  - no gateway order yet            -> the payment is closed (FAILED, BOOKING_CANCELLED)
 *  - gateway order open (PENDING)    -> closed the same way, but the order stays under a short tail of authoritative checks, so a
 *                                       customer who still pays is caught (late success -> exception, never an ordinary payment)
 *  - already paid, booking was CONFIRMED (not yet ACTIVE) and AUTO_REFUND_ON_CANCEL -> automatic full refund (REFUND_PENDING; the
 *                                       recovery worker calls the gateway; failures reach the payment-exception queue)
 *  - already paid otherwise (SUCCEEDED) -> a PAID_BOOKING_CANCELLED exception + staff alert + customer notice. NOT refunded here: the
 *                                       refund policy is open (Q-17/Q-21), so a person decides.
 *  - refund already in progress/done -> untouched.
 */
@Injectable()
export class PaymentRecoveryService implements BookingHook, OnModuleInit {
  private readonly logger = new Logger(PaymentRecoveryService.name);

  constructor(
    private readonly repository: PaymentRepository,
    private readonly payments: PaymentService,
    private readonly bookings: BookingService,
    private readonly hooks: BookingLifecycleHooks,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.hooks.register(this);
  }

  async onCancelled(
    bookingId: string,
    actor: { kind: string; userId: string | null },
    tx: Prisma.TransactionClient,
    fromStatus: string,
  ): Promise<void> {
    // A booking can hold several payments (the booking fee and, DEC-11, other fees); each is settled on its own.
    for (const payment of await this.repository.lockOpenForBooking(bookingId, tx)) {
      await this.settleOnCancel(payment, bookingId, actor, tx, fromStatus);
    }
  }

  private async settleOnCancel(
    payment: PaymentRecord,
    bookingId: string,
    actor: { kind: string; userId: string | null },
    tx: Prisma.TransactionClient,
    fromStatus: string,
  ): Promise<void> {
    if (payment.status === 'CREATED' || payment.status === 'PENDING') {
      const hasOrder = payment.status === 'PENDING';
      await this.repository.update(
        payment.id,
        {
          status: 'FAILED',
          failureReason: 'BOOKING_CANCELLED',
          reconcileAttempts: 0,
          reconcileNextAt: hasOrder ? new Date(Date.now() + RECOVERY.tailFirstDelayMs) : null,
          reconcileClaimedUntil: null,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'payment.closed_booking_cancelled',
          entityType: 'payment',
          entityId: payment.id,
          actorId: actor.userId,
          metadata: { from: payment.status, to: 'FAILED', bookingId, gatewayOrderOpen: hasOrder },
        },
        tx,
      );
      return;
    }
    if (payment.status === 'SUCCEEDED') {
      // DEC-04: a paid booking cancelled before it became ACTIVE is refunded in full automatically; after that staff decide.
      if (
        this.config.autoRefundOnCancel &&
        fromStatus === 'CONFIRMED' &&
        payment.feeCode === BOOKING_FEE_CODE
      ) {
        await this.payments.requestAutoRefundLocked(payment, actor, tx);
        return;
      }
      await this.flagPaidForCancelled(payment, tx, 'cancellation');
    }
  }

  /** Records that money is held for a cancelled booking. Once per payment (the dedupe key), whoever notices first. */
  private async flagPaidForCancelled(
    payment: PaymentRecord,
    tx: Prisma.TransactionClient,
    source: string,
  ): Promise<void> {
    await this.payments.raiseException(
      {
        dedupeKey: `PAID_BOOKING_CANCELLED:${payment.id}`,
        kind: 'PAID_BOOKING_CANCELLED',
        paymentId: payment.id,
        bookingId: payment.bookingId,
        bookingStatus: 'CANCELLED',
        paymentStatus: payment.status,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        providerOrderId: payment.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        requiredAction: 'DECIDE_REFUND_OR_RESOLVE',
        details: { source, receiptNumber: payment.receiptNumber },
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
  }

  /**
   * One pass of the recovery sweeper. Safe to run in several workers at once (rows are claimed atomically) and to repeat (every
   * step is idempotent). Errors in one item never stop the others.
   */
  async runOnce(): Promise<RecoveryRun> {
    const run: RecoveryRun = {
      claimed: 0,
      checked: 0,
      failed: 0,
      replayed: 0,
      escalated: 0,
      flaggedCancelled: 0,
    };

    // 1. Webhooks that arrived before their order: apply once the order exists, escalate if it never does.
    const events = await this.repository.findUnknownOrderEvents(RECOVERY.unknownOrderBatch);
    for (const event of events) {
      try {
        if (await this.payments.replayUnknownOrderEvent(event)) {
          run.replayed++;
        } else if (Date.now() - event.createdAt.getTime() > RECOVERY.unknownOrderEscalateAfterMs) {
          await this.repository.transaction(async (tx) => {
            await this.payments.raiseException(
              {
                dedupeKey: `UNKNOWN_ORDER_EVENT:${event.providerEventId}`,
                kind: 'UNKNOWN_ORDER_EVENT',
                providerOrderId: event.providerOrderId,
                providerPaymentId: event.providerPaymentId,
                amountMinor: event.amountMinor,
                currency: event.currency,
                requiredAction: 'FIND_ORDER_AT_GATEWAY_AND_REFUND_OR_RESOLVE',
                details: { outcome: event.outcome },
              },
              tx,
            );
            await this.repository.setEventResult(
              event.providerEventId,
              { applied: false, note: 'UNKNOWN_ORDER_ESCALATED' },
              tx,
            );
          });
          run.escalated++;
        }
      } catch (error) {
        run.failed++;
        this.logger.error(`Replay of a stored notification failed: ${(error as Error).message}`);
      }
    }

    // 2. Payments (and refunds) whose authoritative check is due.
    const ids = await this.repository.claimDue(RECOVERY.batchSize, RECOVERY.claimSeconds);
    run.claimed = ids.length;
    for (const id of ids) {
      try {
        await this.payments.reconcileNow(id);
        run.checked++;
      } catch (error) {
        // The claim lapses by itself, so the item is picked up again later.
        run.failed++;
        this.logger.error(`Payment check failed: ${(error as Error).message}`);
      }
    }

    // 3. Backstop: money held for cancelled bookings that nobody has been alerted about.
    const paid = await this.repository.findPaidForCancelledBookings(RECOVERY.cancelledSweepBatch);
    for (const item of paid) {
      try {
        await this.repository.transaction(async (tx) => {
          await this.bookings.lockBooking(item.bookingId, tx);
          const payment = await this.repository.lock(item.paymentId, tx);
          if (payment?.status === 'SUCCEEDED')
            await this.flagPaidForCancelled(payment, tx, 'sweep');
        });
        run.flaggedCancelled++;
      } catch (error) {
        run.failed++;
        this.logger.error(`Cancelled-booking sweep failed: ${(error as Error).message}`);
      }
    }
    return run;
  }
}
