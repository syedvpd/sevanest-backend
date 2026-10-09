import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  async findEligible(
    criteria: EligibleWorkerCriteria,
    order: EligibleOrder,
    skip: number,
    take: number,
  ): Promise<{ items: EligibleWorker[]; total: number }> {
    const where = this.where(criteria);
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<PageRow[]>(Prisma.sql`
        SELECT wp.id, wp.user_id AS "userId", wp.name,
               wp.experience_months AS "experienceMonths",
               wpref.engagement_preference::text AS "engagementPreference"
        FROM worker_profiles wp
        JOIN users u ON u.id = wp.user_id
        LEFT JOIN worker_work_preferences wpref ON wpref.worker_id = wp.id
        WHERE ${where}
        ORDER BY ${ORDER_BY[order]}
        LIMIT ${take} OFFSET ${skip}`),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT count(*)::int AS total
        FROM worker_profiles wp
        JOIN users u ON u.id = wp.user_id
        WHERE ${where}`),
    ]);
    return { items: await this.hydrate(rows), total: totals[0]?.total ?? 0 };
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
    if (c.language) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM worker_languages wl WHERE wl.worker_id = wp.id AND wl.language_code = ${c.language})`,
      );
    }
    if (c.minExperienceMonths !== undefined) {
      conditions.push(Prisma.sql`wp.experience_months >= ${c.minExperienceMonths}`);
    }
    return Prisma.join(conditions, ' AND ');
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
