import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { AlertsService } from '../alerts/alerts.service';
import { PermissionCode } from '../users/rbac.constants';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';

export interface BookingSweepRun {
  noResponseAlerts: number;
  stuckPaymentAlerts: number;
  autoCancelled: number;
  reassigned: number;
  failed: number;
}

const BATCH = 100;

/**
 * Scheduled booking checks. Every rule is switched on by configuration and does nothing while its setting is unset, because the
 * business has not decided the periods (Q-55 worker response, Q-78 unpaid bookings):
 *  - WORKER_RESPONSE_HOURS: a matched worker who has not answered by the deadline raises a BOOKING_NO_RESPONSE alert (nothing is
 *    reassigned automatically);
 *  - WORKER_REASSIGN_HOURS: a worker who is still silent then loses the booking back to matching (decline-equivalent, audited, DEC-02);
 *  - PENDING_PAYMENT_ALERT_HOURS: a booking waiting for payment that long raises a BOOKING_STUCK_PAYMENT alert;
 *  - PENDING_PAYMENT_AUTO_CANCEL_HOURS: such a booking is cancelled through the normal cancellation path (its payment is closed by
 *    the cancellation hook; a payment that already succeeded is never refunded here).
 * Re-running is harmless: alerts are deduplicated per booking and a cancelled booking is no longer waiting.
 */
@Injectable()
export class BookingSweepService {
  private readonly logger = new Logger(BookingSweepService.name);

  constructor(
    private readonly repository: BookingRepository,
    private readonly bookings: BookingService,
    private readonly alerts: AlertsService,
    private readonly config: AppConfigService,
  ) {}

  async runOnce(): Promise<BookingSweepRun> {
    const run: BookingSweepRun = {
      noResponseAlerts: 0,
      stuckPaymentAlerts: 0,
      autoCancelled: 0,
      reassigned: 0,
      failed: 0,
    };
    const ops = this.config.ops;

    if (ops.workerResponseHours) {
      for (const item of await this.repository.findNoResponse(BATCH)) {
        try {
          await this.alerts.raise({
            dedupeKey: `BOOKING_NO_RESPONSE:${item.id}`,
            type: 'BOOKING_NO_RESPONSE',
            severity: 'WARNING',
            title: 'A matched worker has not responded in time',
            requiredPermission: PermissionCode.BOOKING_MANAGE,
            entityType: 'booking',
            entityId: item.id,
            detail: { respondBy: item.respondBy.toISOString() },
          });
          run.noResponseAlerts++;
        } catch (error) {
          run.failed++;
          this.logger.error(`No-response alert failed: ${(error as Error).message}`);
        }
      }
    }

    // Reassign (DEC-02): after WORKER_REASSIGN_HOURS the booking returns to matching. The deadline (respondBy) was set WORKER_RESPONSE_HOURS
    // after the match, so the booking is overdue by WORKER_REASSIGN_HOURS once respondBy is (reassign - response) hours old.
    if (ops.workerResponseHours && ops.workerReassignHours > ops.workerResponseHours) {
      const cutoff = new Date(
        Date.now() - (ops.workerReassignHours - ops.workerResponseHours) * 3_600_000,
      );
      for (const item of await this.repository.findNoResponse(BATCH, cutoff)) {
        try {
          if (await this.bookings.autoReassignNoResponse(item.id, cutoff)) run.reassigned++;
        } catch (error) {
          run.failed++;
          this.logger.error(`Auto-reassign failed: ${(error as Error).message}`);
        }
      }
    }

    // Auto-cancel first (it is the stronger rule), then alert on what is still waiting.
    if (ops.pendingPaymentAutoCancelHours) {
      const cutoff = new Date(Date.now() - ops.pendingPaymentAutoCancelHours * 3_600_000);
      for (const item of await this.repository.findWaitingForPayment(cutoff, BATCH)) {
        try {
          if (await this.bookings.autoCancelUnpaid(item.id, ops.pendingPaymentAutoCancelHours)) {
            run.autoCancelled++;
          }
        } catch (error) {
          run.failed++;
          this.logger.error(`Auto-cancel failed: ${(error as Error).message}`);
        }
      }
    }
    if (ops.pendingPaymentAlertHours) {
      const cutoff = new Date(Date.now() - ops.pendingPaymentAlertHours * 3_600_000);
      for (const item of await this.repository.findWaitingForPayment(cutoff, BATCH)) {
        try {
          await this.alerts.raise({
            dedupeKey: `BOOKING_STUCK_PAYMENT:${item.id}`,
            type: 'BOOKING_STUCK_PAYMENT',
            severity: 'WARNING',
            title: 'A booking has been waiting for payment for a long time',
            requiredPermission: PermissionCode.BOOKING_MANAGE,
            entityType: 'booking',
            entityId: item.id,
            detail: { waitingSince: item.updatedAt.toISOString() },
          });
          run.stuckPaymentAlerts++;
        } catch (error) {
          run.failed++;
          this.logger.error(`Stuck-payment alert failed: ${(error as Error).message}`);
        }
      }
    }
    return run;
  }
}
