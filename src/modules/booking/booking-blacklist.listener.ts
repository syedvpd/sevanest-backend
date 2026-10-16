import { Injectable, OnModuleInit } from '@nestjs/common';
import { WorkerBlacklistHooks } from '../workers/worker-blacklist.hooks';
import { AlertsService } from '../alerts/alerts.service';
import { PermissionCode } from '../users/rbac.constants';
import { BookingRepository } from './booking.repository';

/**
 * DEC-06: when a worker is blacklisted, every booking they still hold becomes a staff alert (one per booking, deduplicated), because the
 * platform must not silently keep sending a customer a worker who was removed. Staff then cancel, replace or re-match each one.
 */
@Injectable()
export class BookingBlacklistListener implements OnModuleInit {
  constructor(
    private readonly hooks: WorkerBlacklistHooks,
    private readonly repository: BookingRepository,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit(): void {
    this.hooks.register(async ({ workerId, reason }) => {
      for (const id of await this.repository.findOpenIdsForWorker(workerId)) {
        await this.alerts.raise({
          dedupeKey: `WORKER_BLACKLISTED_BOOKING:${id}`,
          type: 'WORKER_BLACKLISTED_BOOKING',
          severity: 'CRITICAL',
          title: 'A blacklisted worker still holds this booking',
          requiredPermission: PermissionCode.BOOKING_MANAGE,
          entityType: 'booking',
          entityId: id,
          detail: { workerId, reason },
        });
      }
    });
  }
}
