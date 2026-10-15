import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { indiaToday } from '../../common/time/india';
import { workerBusyCondition } from '../../common/scheduling/worker-busy';
import { verifiedWorkerCondition } from '../verification/verification-eligibility';
import type { EligibleOrder, EligibleWorker, EligibleWorkerCriteria } from './search.types';

interface PageRow {
  id: string;
  userId: string;
  name: string;
  experienceMonths: number | null;
  engagementPreference: EligibleWorker['engagementPreference'];
}

const ORDER_BY: Record<EligibleOrder, Prisma.Sql> = {
  EXPERIENCE_DESC: Prisma.sql`wp.experience_months DESC NULLS LAST, wp.id ASC`,
  EXPERIENCE_ASC: Prisma.sql`wp.experience_months ASC NULLS LAST, wp.id ASC`,
  RATING_DESC: Prisma.sql`(SELECT rs.rating_sum::float8 / NULLIF(rs.rating_count, 0) FROM worker_rating_summaries rs WHERE rs.worker_id = wp.id) DESC NULLS LAST, wp.experience_months DESC NULLS LAST, wp.id ASC`,
  SUBMITTED_ASC: Prisma.sql`wp.submitted_at ASC, wp.id ASC`,
};

/**
 * Read side of the workforce. Search is a deliberate READ-ONLY query module: it answers "who is eligible" with one
 * parameterised SQL statement over the tables that Workers, Availability, Service Categories and Verification own, because
 * correct pagination and totals need the filter and the order inside the database (a per-module id intersection cannot page).
 * It never writes. The definition of "verified" is Verification's own SQL fragment, so it cannot drift. Constant number of
 * statements per request (page, count, four batched look-ups) - no per-row queries.
 */
@Injectable()
export class SearchRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async findEligible(
    criteria: EligibleWorkerCriteria,
    order: EligibleOrder,
    skip: number,
    take: number,
  ): Promise<{ items: EligibleWorker[]; total: number }> {
    const where = this.where(criteria);
    // One statement answers both the page and the total (count(*) OVER () is computed on the already filtered set), so the
    // expensive eligibility filter runs once per search instead of twice. A page past the end returns no rows and therefore
    // no total; only then is a separate count needed.
    const rows = await this.prisma.$queryRaw<Array<PageRow & { total: number }>>(Prisma.sql`
      SELECT wp.id, wp.user_id AS "userId", wp.name,
             wp.experience_months AS "experienceMonths",
             wpref.engagement_preference::text AS "engagementPreference",
             (count(*) OVER ())::int AS total
      FROM worker_profiles wp
      JOIN users u ON u.id = wp.user_id
      LEFT JOIN worker_work_preferences wpref ON wpref.worker_id = wp.id
      WHERE ${where}
      ORDER BY ${ORDER_BY[order]}
      LIMIT ${take} OFFSET ${skip}`);
    let total = rows[0]?.total ?? 0;
    if (rows.length === 0 && skip > 0) {
      const totals = await this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT count(*)::int AS total
        FROM worker_profiles wp
        JOIN users u ON u.id = wp.user_id
        WHERE ${where}`);
      total = totals[0]?.total ?? 0;
    }
    return { items: await this.hydrate(rows), total };
  }

  /** Which of the candidate start minutes are taken for this worker on a date (a held booking overlaps, or a confirmed interview/trial). */
  async takenStarts(
    workerId: string,
    date: string,
    starts: number[],
    lengthMinutes: number,
  ): Promise<Set<number>> {
    if (starts.length === 0) return new Set();
    // One statement tests every candidate window (was one query per slot: up to a dozen concurrent queries against a pool of ten).
    const [busyRows, interviews] = await Promise.all([
      this.prisma.$queryRaw<Array<{ start: number; busy: boolean }>>(Prisma.sql`
        SELECT s.m AS start, ${workerBusyCondition(Prisma.sql`${workerId}::uuid`, {
          startDate: date,
          engagement: 'HOURLY',
          fromMinute: Prisma.sql`s.m`,
          toMinute: Prisma.sql`s.m + ${lengthMinutes}::int`,
          bufferMinutes: this.config.travelBufferMinutes,
        })} AS busy
        FROM unnest(${starts}::int[]) AS s(m)`),
      this.prisma.$queryRaw<Array<{ minute: number }>>(Prisma.sql`
        SELECT (extract(hour FROM it.scheduled_at AT TIME ZONE 'Asia/Kolkata') * 60
              + extract(minute FROM it.scheduled_at AT TIME ZONE 'Asia/Kolkata'))::int AS minute
        FROM interview_trials it JOIN bookings b ON b.id = it.booking_id
        WHERE b.worker_id = ${workerId}::uuid AND it.status = 'CONFIRMED'
          AND (it.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = ${date}::date`),
    ]);
    const busy = new Set(busyRows.filter((r) => r.busy === true).map((r) => Number(r.start)));
    const taken = new Set<number>();
    for (const from of starts) {
      const clash = interviews.some(
        (x) => x.minute < from + lengthMinutes && from < x.minute + lengthMinutes,
      );
      if (busy.has(from) || clash) taken.add(from);
    }
    return taken;
  }

  /** True when the customer has blocked, or been blocked by, anyone (such a customer's search cannot share cached pages). */
  async hasBlocks(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ one: number }>>(Prisma.sql`
      SELECT 1 AS one FROM user_blocks
      WHERE blocker_user_id = ${userId}::uuid OR blocked_user_id = ${userId}::uuid LIMIT 1`);
    return rows.length > 0;
  }

  /**
   * Customer visibility of specific workers (profile, shortlist): active account, submitted profile, fully verified. Unlike
   * `findEligible` it does not ask for a category or area. Ineligible and unknown ids are simply absent.
   */
  async findVisibleByIds(ids: string[], forCustomerUserId?: string): Promise<EligibleWorker[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.$queryRaw<PageRow[]>(Prisma.sql`
      SELECT wp.id, wp.user_id AS "userId", wp.name,
             wp.experience_months AS "experienceMonths",
             wpref.engagement_preference::text AS "engagementPreference"
      FROM worker_profiles wp
      JOIN users u ON u.id = wp.user_id
      LEFT JOIN worker_work_preferences wpref ON wpref.worker_id = wp.id
      WHERE wp.id = ANY(${ids}::uuid[])
        AND wp.onboarding_status = 'SUBMITTED'
        AND u.type = 'WORKER' AND u.status = 'ACTIVE'
        AND ${verifiedWorkerCondition('wp.id')}
        AND ${this.notBlocked(forCustomerUserId)}`);
    return this.hydrate(rows);
  }

  /**
   * Visible (not moderated away) reviews of one worker, newest first, with the reviewer's FIRST NAME only. Callers have already
   * checked the worker is visible to customers.
   */
  async listVisibleReviews(
    workerId: string,
    skip: number,
    take: number,
  ): Promise<{
    items: Array<{
      score: number;
      comment: string | null;
      createdAt: Date;
      reviewerFirstName: string | null;
    }>;
    total: number;
  }> {
    const [items, totals] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          score: number;
          comment: string | null;
          createdAt: Date;
          reviewerFirstName: string | null;
        }>
      >(Prisma.sql`
        SELECT r.score::int AS score, r.review_text AS comment, r.created_at AS "createdAt",
               NULLIF(split_part(btrim(cp.name), ' ', 1), '') AS "reviewerFirstName"
        FROM ratings r
        LEFT JOIN customer_profiles cp ON cp.user_id = r.customer_user_id
        WHERE r.worker_id = ${workerId}::uuid AND r.status = 'VISIBLE'
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${take} OFFSET ${skip}`),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT count(*)::int AS total FROM ratings r
        WHERE r.worker_id = ${workerId}::uuid AND r.status = 'VISIBLE'`),
    ]);
    return { items, total: totals[0]?.total ?? 0 };
  }

  /** Aggregate rating of each given worker (workers with no rating are absent). */
  async ratingSummaries(ids: string[]): Promise<Map<string, { sum: number; count: number }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ id: string; sum: number; count: number }>>(
      Prisma.sql`
      SELECT worker_id AS id, rating_sum AS sum, rating_count AS count
      FROM worker_rating_summaries WHERE worker_id = ANY(${ids}::uuid[]) AND rating_count > 0`,
    );
    return new Map(rows.map((r) => [r.id, { sum: r.sum, count: r.count }]));
  }

  /** Cheap yes/no for one worker: the same eligibility, one statement, no hydration. */
  async isEligible(criteria: EligibleWorkerCriteria): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT wp.id FROM worker_profiles wp
      JOIN users u ON u.id = wp.user_id
      WHERE ${this.where(criteria)}
      LIMIT 1`);
    return rows.length === 1;
  }

  private where(c: EligibleWorkerCriteria): Prisma.Sql {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`wp.onboarding_status = 'SUBMITTED'`,
      Prisma.sql`u.type = 'WORKER' AND u.status = 'ACTIVE'`,
      verifiedWorkerCondition('wp.id'),
      Prisma.sql`EXISTS (SELECT 1 FROM worker_skills ws WHERE ws.worker_id = wp.id AND ws.category_id = ${c.categoryId}::uuid)`,
      Prisma.sql`EXISTS (SELECT 1 FROM worker_preferred_areas wpa WHERE wpa.worker_id = wp.id AND wpa.area_id = ${c.areaId}::uuid)`,
    ];
    if (c.workerId) {
      conditions.push(Prisma.sql`wp.id = ${c.workerId}::uuid`);
    }
    if (c.excludeWorkerId) {
      conditions.push(Prisma.sql`wp.id <> ${c.excludeWorkerId}::uuid`);
    }
    if (c.engagement) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM worker_work_preferences wwp WHERE wwp.worker_id = wp.id AND wwp.engagement_preference = ${c.engagement}::"EngagementPreference")`,
      );
    }
    if (c.window) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM worker_time_windows tw WHERE tw.worker_id = wp.id AND tw.start_minute <= ${c.window.fromMinute} AND tw.end_minute >= ${c.window.toMinute})`,
      );
    }
    if (c.window && !c.skipBusy) {
      conditions.push(
        Prisma.sql`NOT ${workerBusyCondition(Prisma.sql`wp.id`, {
          startDate: c.startDate ?? indiaToday(),
          engagement: c.engagement,
          fromMinute: c.window.fromMinute,
          toMinute: c.window.toMinute,
          excludeBookingId: c.excludeBookingId,
          bufferMinutes: this.config.travelBufferMinutes,
        })}`,
      );
    }
    if (c.language) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM worker_languages wl WHERE wl.worker_id = wp.id AND wl.language_code = ${c.language})`,
      );
    }
    if (c.minExperienceMonths !== undefined) {
      conditions.push(Prisma.sql`wp.experience_months >= ${c.minExperienceMonths}`);
    }
    if (c.minRating !== undefined) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM worker_rating_summaries rs WHERE rs.worker_id = wp.id AND rs.rating_count > 0 AND rs.rating_sum::float8 / rs.rating_count >= ${c.minRating})`,
      );
    }
    conditions.push(this.notBlocked(c.forCustomerUserId));
    return Prisma.join(conditions, ' AND ');
  }

  /** A block in either direction between the customer and the worker's account hides the worker from that customer. */
  private notBlocked(customerUserId: string | undefined): Prisma.Sql {
    if (!customerUserId) return Prisma.sql`TRUE`;
    return Prisma.sql`NOT EXISTS (
      SELECT 1 FROM user_blocks ub
      WHERE (ub.blocker_user_id = ${customerUserId}::uuid AND ub.blocked_user_id = wp.user_id)
         OR (ub.blocker_user_id = wp.user_id AND ub.blocked_user_id = ${customerUserId}::uuid))`;
  }

  private async hydrate(rows: PageRow[]): Promise<EligibleWorker[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [categories, languages, areas, windows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ workerId: string; code: string; name: string }>>(Prisma.sql`
        SELECT ws.worker_id AS "workerId", sc.code, sc.name
        FROM worker_skills ws JOIN service_categories sc ON sc.id = ws.category_id
        WHERE ws.worker_id = ANY(${ids}::uuid[]) AND sc.is_enabled
        ORDER BY sc.code`),
      this.prisma.$queryRaw<Array<{ workerId: string; code: string }>>(Prisma.sql`
        SELECT worker_id AS "workerId", language_code AS code
        FROM worker_languages WHERE worker_id = ANY(${ids}::uuid[])
        ORDER BY language_code`),
      this.prisma.$queryRaw<Array<{ workerId: string; id: string; name: string; city: string }>>(
        Prisma.sql`
        SELECT wpa.worker_id AS "workerId", sa.id, sa.name, sa.city
        FROM worker_preferred_areas wpa JOIN service_areas sa ON sa.id = wpa.area_id
        WHERE wpa.worker_id = ANY(${ids}::uuid[]) AND sa.is_enabled
        ORDER BY sa.city, sa.name, sa.id`,
      ),
      this.prisma.$queryRaw<Array<{ workerId: string; startMinute: number; endMinute: number }>>(
        Prisma.sql`
        SELECT worker_id AS "workerId", start_minute AS "startMinute", end_minute AS "endMinute"
        FROM worker_time_windows WHERE worker_id = ANY(${ids}::uuid[])
        ORDER BY start_minute`,
      ),
    ]);
    const group = <T extends { workerId: string }>(list: T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const item of list) map.set(item.workerId, [...(map.get(item.workerId) ?? []), item]);
      return map;
    };
    const cat = group(categories);
    const lang = group(languages);
    const area = group(areas);
    const win = group(windows);
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      experienceMonths: r.experienceMonths,
      engagementPreference: r.engagementPreference,
      categories: (cat.get(r.id) ?? []).map((c) => ({ code: c.code, name: c.name })),
      languages: (lang.get(r.id) ?? []).map((l) => l.code),
      serviceAreas: (area.get(r.id) ?? []).map((a) => ({ id: a.id, name: a.name, city: a.city })),
      availability: (win.get(r.id) ?? []).map((w) => ({
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      })),
    }));
  }
}
