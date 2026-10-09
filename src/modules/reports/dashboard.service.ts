import { Injectable } from '@nestjs/common';
import { indiaToday } from '../../common/time/india';
import { PermissionCode } from '../users/rbac.constants';
import { ReportsRepository } from './reports.repository';

export interface DashboardView {
  generatedAt: string;
  /** Only the sections the caller's role may see appear; an admin with none gets an empty object. */
  sections: {
    bookings?: { byStatus: Array<{ status: string; count: number }> };
    workers?: { registered: number; verifiedAndActive: number };
    pendingKyc?: { submitted: number; inReview: number };
    complaints?: { open: number; inProgress: number; escalated: number; unassigned: number };
    replacements?: { requested: number; approved: number };
    collections?: Array<{ currency: string; todayMinor: number; monthToDateMinor: number }>;
  };
}

/**
 * The operations dashboard (FRD FM-14 step 1: bookings, active workers, pending KYC, complaints, replacements, collections).
 * FRD section 2 gives each role a different slice ("Limited (KYC)", "Limited (support)"), so each section is shown only to a
 * caller holding the permission that already guards the same data elsewhere - the dashboard never widens access, and no
 * role-to-section table has to be invented. Counts are current, read-only and each section is one aggregate statement.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly repository: ReportsRepository) {}

  async build(permissions: readonly string[]): Promise<DashboardView> {
    const has = (code: string): boolean => permissions.includes(code);
    const today = indiaToday();
    const monthStart = `${today.slice(0, 8)}01`;
    const [bookings, workers, kyc, complaints, replacements, collections] = await Promise.all([
      has(PermissionCode.BOOKING_VIEW) ? this.repository.bookingsByStatus() : undefined,
      has(PermissionCode.WORKER_VIEW) ? this.repository.activeWorkers() : undefined,
      has(PermissionCode.VERIFICATION_REVIEW)
        ? this.repository.pendingVerificationChecks()
        : undefined,
      has(PermissionCode.SUPPORT_VIEW) ? this.repository.openTickets() : undefined,
      has(PermissionCode.REPLACEMENT_VIEW) ? this.repository.openReplacements() : undefined,
      has(PermissionCode.PAYMENT_VIEW)
        ? this.repository.collectionsSince(today, monthStart)
        : undefined,
    ]);
    return {
      generatedAt: new Date().toISOString(),
      sections: {
        ...(bookings ? { bookings: { byStatus: bookings } } : {}),
        ...(workers
          ? { workers: { registered: workers.registered, verifiedAndActive: workers.verified } }
          : {}),
        ...(kyc ? { pendingKyc: kyc } : {}),
        ...(complaints ? { complaints } : {}),
        ...(replacements ? { replacements } : {}),
        ...(collections
          ? {
              collections: collections.map((c) => ({
                currency: c.currency,
                todayMinor: Number(c.todayMinor),
                monthToDateMinor: Number(c.monthMinor),
              })),
            }
          : {}),
      },
    };
  }
}
