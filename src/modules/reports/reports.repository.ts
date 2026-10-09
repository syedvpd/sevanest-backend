import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { verifiedWorkerCondition } from '../verification/verification-eligibility';
import type { ReportInterval } from './dto/reports.dto';

type Db = Prisma.TransactionClient;

const COLUMN = /^[a-z][a-z_]*(\.[a-z][a-z_]*)?$/;
const IST = Prisma.sql`'Asia/Kolkata'`;

const BUCKET: Record<ReportInterval, Prisma.Sql> = {
  day: Prisma.sql`'day'`,
  week: Prisma.sql`'week'`,
  month: Prisma.sql`'month'`,
};

export interface Range {
  /** YYYY-MM-DD, inclusive, India calendar. */
  from: string;
  to: string;
}

/** `[from 00:00, to + 1 day 00:00)` in India time, written so an index on the column stays usable. */
function within(column: string, range: Range): Prisma.Sql {
  if (!COLUMN.test(column)) throw new Error('within expects a column reference');
  const col = Prisma.raw(column);
  return Prisma.sql`${col} >= ((${range.from}::date)::timestamp AT TIME ZONE ${IST})
    AND ${col} < (((${range.to}::date + 1))::timestamp AT TIME ZONE ${IST})`;
}

function period(column: string, interval: ReportInterval): Prisma.Sql {
  if (!COLUMN.test(column)) throw new Error('period expects a column reference');
  return Prisma.sql`to_char(date_trunc(${BUCKET[interval]}, ${Prisma.raw(column)} AT TIME ZONE ${IST}), 'YYYY-MM-DD')`;
}

export interface CountPoint {
  period: string;
  count: number;
}

/**
 * Reporting read side. Reports are READ-ONLY by construction: every query runs inside a transaction that PostgreSQL itself
 * has set READ ONLY, so even a mistake in this file cannot change data; a test also forbids any writing statement here. Each
 * report is a constant number of aggregate statements (no per-row queries). Filters use the indexed `created_at`/`paid_at`
 * columns with half-open ranges. Like Search, this module reads other modules' tables with parameterised SELECTs on purpose:
 * correct aggregates and paging must happen in the database. It owns no table.
 */
@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Runs `work` in a READ ONLY transaction (any write inside fails with SQLSTATE 25006). */
  readOnly<T>(work: (db: Db) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return work(tx);
    });
  }

  newCustomers(range: Range, interval: ReportInterval): Promise<CountPoint[]> {
    return this.readOnly((db) =>
      db.$queryRaw<CountPoint[]>(Prisma.sql`
        SELECT ${period('u.created_at', interval)} AS period, count(*)::int AS count
        FROM users u
        WHERE u.type = 'CUSTOMER' AND ${within('u.created_at', range)}
        GROUP BY 1 ORDER BY 1`),
    );
  }

  workerRegistrations(
    range: Range,
    interval: ReportInterval,
  ): Promise<Array<{ period: string; registered: number; verified: number }>> {
    return this.readOnly((db) =>
      db.$queryRaw(Prisma.sql`
        SELECT ${period('wp.created_at', interval)} AS period,
               count(*)::int AS registered,
               (count(*) FILTER (WHERE ${verifiedWorkerCondition('wp.id')}))::int AS verified
        FROM worker_profiles wp
        WHERE ${within('wp.created_at', range)}
        GROUP BY 1 ORDER BY 1`),
    );
  }

  bookingFunnel(
    range: Range,
    interval: ReportInterval,
  ): Promise<Array<{ period: string; requests: number; confirmed: number }>> {
    return this.readOnly((db) =>
      db.$queryRaw(Prisma.sql`
        SELECT ${period('b.created_at', interval)} AS period,
               count(*)::int AS requests,
               (count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.to_status = 'CONFIRMED')))::int AS confirmed
        FROM bookings b
        WHERE ${within('b.created_at', range)}
        GROUP BY 1 ORDER BY 1`),
    );
  }

  demandByCategory(
    range: Range,
  ): Promise<Array<{ categoryId: string; code: string; name: string; requests: number }>> {
    return this.readOnly((db) =>
      db.$queryRaw(Prisma.sql`
        SELECT sc.id AS "categoryId", sc.code, sc.name, count(b.id)::int AS requests
        FROM service_categories sc
        LEFT JOIN bookings b ON b.category_id = sc.id AND ${within('b.created_at', range)}
        GROUP BY sc.id, sc.code, sc.name
        ORDER BY requests DESC, sc.code ASC`),
    );
  }

  demandByArea(
    range: Range,
    skip: number,
    take: number,
  ): Promise<{
    items: Array<{ areaId: string; name: string; city: string; requests: number }>;
    total: number;
  }> {
    return this.readOnly(async (db) => {
      const [items, totals] = await Promise.all([
        db.$queryRaw<
          Array<{ areaId: string; name: string; city: string; requests: number }>
        >(Prisma.sql`
          SELECT sa.id AS "areaId", sa.name, sa.city, count(*)::int AS requests
          FROM bookings b JOIN service_areas sa ON sa.id = b.area_id
          WHERE ${within('b.created_at', range)}
          GROUP BY sa.id, sa.name, sa.city
          ORDER BY requests DESC, sa.name ASC, sa.id ASC
          LIMIT ${take} OFFSET ${skip}`),
        db.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT count(DISTINCT b.area_id)::int AS total FROM bookings b WHERE ${within('b.created_at', range)}`),
      ]);
      return { items, total: totals[0]?.total ?? 0 };
    });
  }

  workerUtilization(): Promise<{ verifiedWorkers: number; workersWithActiveBooking: number }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<Array<{ verified: number; busy: number }>>(Prisma.sql`
        SELECT count(*)::int AS verified,
               (count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM bookings b WHERE b.worker_id = wp.id AND b.status = 'ACTIVE')))::int AS busy
        FROM worker_profiles wp JOIN users u ON u.id = wp.user_id
        WHERE wp.onboarding_status = 'SUBMITTED' AND u.type = 'WORKER' AND u.status = 'ACTIVE'
          AND ${verifiedWorkerCondition('wp.id')}`);
      return {
        verifiedWorkers: rows[0]?.verified ?? 0,
        workersWithActiveBooking: rows[0]?.busy ?? 0,
      };
    });
  }

  interviewConversion(range: Range): Promise<{ interviewsHeld: number; confirmed: number }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<Array<{ held: number; confirmed: number }>>(Prisma.sql`
        WITH held AS (
          SELECT b.id FROM bookings b
          WHERE ${within('b.created_at', range)}
            AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.to_status = 'INTERVIEW_TRIAL_COMPLETED')
        )
        SELECT count(*)::int AS held,
               (count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM booking_events e WHERE e.booking_id = held.id AND e.to_status = 'CONFIRMED')))::int AS confirmed
        FROM held`);
      return { interviewsHeld: rows[0]?.held ?? 0, confirmed: rows[0]?.confirmed ?? 0 };
    });
  }

  cancellation(range: Range): Promise<{ total: number; cancelled: number }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<Array<{ total: number; cancelled: number }>>(Prisma.sql`
        SELECT count(*)::int AS total,
               (count(*) FILTER (WHERE b.status = 'CANCELLED'))::int AS cancelled
        FROM bookings b WHERE ${within('b.created_at', range)}`);
      return { total: rows[0]?.total ?? 0, cancelled: rows[0]?.cancelled ?? 0 };
    });
  }

  replacement(range: Range): Promise<{ activeBookings: number; replacementRequests: number }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<Array<{ active: number; requests: number }>>(Prisma.sql`
        WITH cohort AS (
          SELECT b.id FROM bookings b
          WHERE ${within('b.created_at', range)}
            AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.to_status = 'ACTIVE')
        )
        SELECT (SELECT count(*) FROM cohort)::int AS active,
               (SELECT count(*) FROM replacement_requests r WHERE r.booking_id IN (SELECT id FROM cohort))::int AS requests`);
      return {
        activeBookings: rows[0]?.active ?? 0,
        replacementRequests: rows[0]?.requests ?? 0,
      };
    });
  }

  paymentCollections(
    range: Range,
    interval: ReportInterval,
  ): Promise<
    Array<{
      period: string;
      feeCode: string;
      currency: string;
      payments: number;
      grossMinor: string;
      refundedMinor: string;
    }>
  > {
    return this.readOnly((db) =>
      db.$queryRaw(Prisma.sql`
        SELECT ${period('p.paid_at', interval)} AS period, p.fee_code AS "feeCode", p.currency,
               count(*)::int AS payments,
               COALESCE(sum(p.amount_minor), 0)::text AS "grossMinor",
               COALESCE(sum(p.amount_minor) FILTER (WHERE p.status = 'REFUNDED'), 0)::text AS "refundedMinor"
        FROM payments p
        WHERE p.paid_at IS NOT NULL AND ${within('p.paid_at', range)}
        GROUP BY 1, p.fee_code, p.currency
        ORDER BY 1, p.fee_code, p.currency`),
    );
  }

  supportTickets(
    range: Range,
    interval: ReportInterval,
  ): Promise<{
    series: CountPoint[];
    byStatus: Array<{ status: string; count: number }>;
    closed: number;
    averageResolutionSeconds: number | null;
  }> {
    return this.readOnly(async (db) => {
      const [series, byStatus, resolution] = await Promise.all([
        db.$queryRaw<CountPoint[]>(Prisma.sql`
          SELECT ${period('t.created_at', interval)} AS period, count(*)::int AS count
          FROM support_tickets t WHERE ${within('t.created_at', range)}
          GROUP BY 1 ORDER BY 1`),
        db.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
          SELECT t.status::text AS status, count(*)::int AS count
          FROM support_tickets t WHERE ${within('t.created_at', range)}
          GROUP BY 1 ORDER BY 1`),
        db.$queryRaw<Array<{ closed: number; seconds: number | null }>>(Prisma.sql`
          SELECT count(*)::int AS closed,
                 (avg(extract(epoch FROM (t.closed_at - t.created_at))))::float8 AS seconds
          FROM support_tickets t
          WHERE t.status = 'CLOSED' AND ${within('t.created_at', range)}`),
      ]);
      return {
        series,
        byStatus,
        closed: resolution[0]?.closed ?? 0,
        averageResolutionSeconds:
          resolution[0]?.seconds === null || resolution[0]?.seconds === undefined
            ? null
            : Math.round(resolution[0].seconds),
      };
    });
  }

  topRatedWorkers(
    minRatings: number,
    skip: number,
    take: number,
  ): Promise<{
    items: Array<{ workerId: string; name: string; ratingCount: number; ratingSum: number }>;
    total: number;
  }> {
    return this.readOnly(async (db) => {
      const [items, totals] = await Promise.all([
        db.$queryRaw<
          Array<{ workerId: string; name: string; ratingCount: number; ratingSum: number }>
        >(Prisma.sql`
          SELECT s.worker_id AS "workerId", wp.name, s.rating_count AS "ratingCount", s.rating_sum AS "ratingSum"
          FROM worker_rating_summaries s JOIN worker_profiles wp ON wp.id = s.worker_id
          WHERE s.rating_count >= ${minRatings} AND s.rating_count > 0
          ORDER BY (s.rating_sum::numeric / s.rating_count) DESC, s.rating_count DESC, s.worker_id ASC
          LIMIT ${take} OFFSET ${skip}`),
        db.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT count(*)::int AS total FROM worker_rating_summaries s
          WHERE s.rating_count >= ${minRatings} AND s.rating_count > 0`),
      ]);
      return { items, total: totals[0]?.total ?? 0 };
    });
  }

  repeatCustomers(
    range: Range,
    skip: number,
    take: number,
  ): Promise<{
    items: Array<{ customerUserId: string; name: string | null; bookings: number }>;
    total: number;
  }> {
    return this.readOnly(async (db) => {
      const repeated = Prisma.sql`
        SELECT b.customer_user_id, count(*) AS bookings
        FROM bookings b WHERE ${within('b.created_at', range)}
        GROUP BY b.customer_user_id HAVING count(*) > 1`;
      const [items, totals] = await Promise.all([
        db.$queryRaw<
          Array<{ customerUserId: string; name: string | null; bookings: number }>
        >(Prisma.sql`
          SELECT r.customer_user_id AS "customerUserId", cp.name, r.bookings::int AS bookings
          FROM (${repeated}) r LEFT JOIN customer_profiles cp ON cp.user_id = r.customer_user_id
          ORDER BY r.bookings DESC, r.customer_user_id ASC
          LIMIT ${take} OFFSET ${skip}`),
        db.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT count(*)::int AS total FROM (${repeated}) r`),
      ]);
      return { items, total: totals[0]?.total ?? 0 };
    });
  }

  // --- operations dashboard (FRD FM-14 step 1): current counts, each fetched only when the caller may see the section -----

  bookingsByStatus(): Promise<Array<{ status: string; count: number }>> {
    return this.readOnly((db) =>
      db.$queryRaw(Prisma.sql`
        SELECT b.status::text AS status, count(*)::int AS count FROM bookings b GROUP BY 1 ORDER BY 1`),
    );
  }

  activeWorkers(): Promise<{ registered: number; verified: number }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<Array<{ registered: number; verified: number }>>(Prisma.sql`
        SELECT count(*)::int AS registered,
               (count(*) FILTER (WHERE wp.onboarding_status = 'SUBMITTED' AND u.status = 'ACTIVE'
                  AND ${verifiedWorkerCondition('wp.id')}))::int AS verified
        FROM worker_profiles wp JOIN users u ON u.id = wp.user_id`);
      return { registered: rows[0]?.registered ?? 0, verified: rows[0]?.verified ?? 0 };
    });
  }

  pendingVerificationChecks(): Promise<{ submitted: number; inReview: number }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<Array<{ submitted: number; in_review: number }>>(Prisma.sql`
        SELECT (count(*) FILTER (WHERE status = 'SUBMITTED'))::int AS submitted,
               (count(*) FILTER (WHERE status = 'IN_REVIEW'))::int AS in_review
        FROM worker_verification_checks WHERE status IN ('SUBMITTED', 'IN_REVIEW')`);
      return { submitted: rows[0]?.submitted ?? 0, inReview: rows[0]?.in_review ?? 0 };
    });
  }

  openTickets(): Promise<{
    open: number;
    inProgress: number;
    escalated: number;
    unassigned: number;
  }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<
        Array<{ open: number; in_progress: number; escalated: number; unassigned: number }>
      >(Prisma.sql`
        SELECT (count(*) FILTER (WHERE status = 'OPEN'))::int AS open,
               (count(*) FILTER (WHERE status = 'IN_PROGRESS'))::int AS in_progress,
               (count(*) FILTER (WHERE status = 'ESCALATED'))::int AS escalated,
               (count(*) FILTER (WHERE assigned_to_user_id IS NULL))::int AS unassigned
        FROM support_tickets WHERE status <> 'CLOSED'`);
      const r = rows[0];
      return {
        open: r?.open ?? 0,
        inProgress: r?.in_progress ?? 0,
        escalated: r?.escalated ?? 0,
        unassigned: r?.unassigned ?? 0,
      };
    });
  }

  openReplacements(): Promise<{ requested: number; approved: number }> {
    return this.readOnly(async (db) => {
      const rows = await db.$queryRaw<Array<{ requested: number; approved: number }>>(Prisma.sql`
        SELECT (count(*) FILTER (WHERE status = 'REQUESTED'))::int AS requested,
               (count(*) FILTER (WHERE status = 'APPROVED'))::int AS approved
        FROM replacement_requests WHERE status IN ('REQUESTED', 'APPROVED')`);
      return { requested: rows[0]?.requested ?? 0, approved: rows[0]?.approved ?? 0 };
    });
  }

  collectionsSince(
    todayStart: string,
    monthStart: string,
  ): Promise<Array<{ currency: string; todayMinor: string; monthMinor: string }>> {
    return this.readOnly((db) =>
      db.$queryRaw(Prisma.sql`
        SELECT p.currency,
               COALESCE(sum(p.amount_minor) FILTER (WHERE ${within('p.paid_at', { from: todayStart, to: todayStart })}), 0)::text AS "todayMinor",
               COALESCE(sum(p.amount_minor), 0)::text AS "monthMinor"
        FROM payments p
        WHERE p.paid_at IS NOT NULL AND ${within('p.paid_at', { from: monthStart, to: todayStart })}
        GROUP BY p.currency ORDER BY p.currency`),
    );
  }
}
