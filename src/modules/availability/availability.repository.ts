import { Injectable } from '@nestjs/common';
import type { EngagementPreference, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { TimeWindowMinutes } from './domain/time-windows';

type Db = Prisma.TransactionClient | PrismaService;

export interface AreaRecord {
  id: string;
  name: string;
  city: string;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AREA_SELECT = {
  id: true,
  name: true,
  city: true,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ServiceAreaSelect;

export interface WorkerAvailabilityRecord {
  engagementPreference: EngagementPreference | null;
  areas: AreaRecord[];
  windows: TimeWindowMinutes[];
}

/** The only place that reads or writes `service_areas`, `worker_work_preferences`, `worker_preferred_areas`, `worker_time_windows`. */
@Injectable()
export class AvailabilityRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // --- service area master ------------------------------------------------------------------------------------

  findAreaById(id: string, db: Db = this.prisma): Promise<AreaRecord | null> {
    return db.serviceArea.findUnique({ where: { id }, select: AREA_SELECT });
  }

  findAreasByIds(ids: string[], db: Db = this.prisma): Promise<AreaRecord[]> {
    return db.serviceArea.findMany({ where: { id: { in: ids } }, select: AREA_SELECT });
  }

  async listAreas(
    filter: { enabled?: boolean; city?: string },
    skip: number,
    take: number,
  ): Promise<{ items: AreaRecord[]; total: number }> {
    const where: Prisma.ServiceAreaWhereInput = {
      ...(filter.enabled === undefined ? {} : { isEnabled: filter.enabled }),
      ...(filter.city ? { city: { equals: filter.city, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.serviceArea.findMany({
        where,
        orderBy: [{ city: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip,
        take,
        select: AREA_SELECT,
      }),
      this.prisma.serviceArea.count({ where }),
    ]);
    return { items, total };
  }

  createArea(data: { name: string; city: string }, db: Db = this.prisma): Promise<AreaRecord> {
    return db.serviceArea.create({ data, select: AREA_SELECT });
  }

  async lockArea(id: string, tx: Prisma.TransactionClient): Promise<AreaRecord | null> {
    await tx.$queryRaw`SELECT id FROM service_areas WHERE id = ${id}::uuid FOR UPDATE`;
    return this.findAreaById(id, tx);
  }

  updateArea(
    id: string,
    data: { name?: string; city?: string; isEnabled?: boolean },
    tx: Prisma.TransactionClient,
  ): Promise<AreaRecord> {
    return tx.serviceArea.update({ where: { id }, data, select: AREA_SELECT });
  }

  // --- worker availability ------------------------------------------------------------------------------------

  /**
   * Serialises every availability change of ONE worker for the rest of the transaction without locking the Workers
   * module's table (transaction-scoped advisory lock keyed by the worker id).
   */
  async lockWorker(workerId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`worker-availability:${workerId}`}, 0))`;
  }

  async get(workerId: string, db: Db = this.prisma): Promise<WorkerAvailabilityRecord> {
    const [preference, areaRows, windowRows] = await Promise.all([
      db.workerWorkPreference.findUnique({
        where: { workerId },
        select: { engagementPreference: true },
      }),
      db.workerPreferredArea.findMany({
        where: { workerId },
        select: { area: { select: AREA_SELECT } },
        orderBy: [{ area: { city: 'asc' } }, { area: { name: 'asc' } }],
      }),
      db.workerTimeWindow.findMany({
        where: { workerId },
        select: { startMinute: true, endMinute: true },
        orderBy: { startMinute: 'asc' },
      }),
    ]);
    return {
      engagementPreference: preference?.engagementPreference ?? null,
      areas: areaRows.map((row) => row.area),
      windows: windowRows,
    };
  }

  /** What is configured, without loading it (submission check). */
  async summary(
    workerId: string,
  ): Promise<{ hasPreference: boolean; areaCount: number; windowCount: number }> {
    const [preference, areaCount, windowCount] = await Promise.all([
      this.prisma.workerWorkPreference.count({ where: { workerId } }),
      this.prisma.workerPreferredArea.count({ where: { workerId } }),
      this.prisma.workerTimeWindow.count({ where: { workerId } }),
    ]);
    return { hasPreference: preference > 0, areaCount, windowCount };
  }

  async setPreference(
    workerId: string,
    engagementPreference: EngagementPreference,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workerWorkPreference.upsert({
      where: { workerId },
      create: { workerId, engagementPreference },
      update: { engagementPreference },
      select: { workerId: true },
    });
  }

  async currentPreference(
    workerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<EngagementPreference | null> {
    const row = await tx.workerWorkPreference.findUnique({
      where: { workerId },
      select: { engagementPreference: true },
    });
    return row?.engagementPreference ?? null;
  }

  async preferredAreaIds(workerId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.workerPreferredArea.findMany({
      where: { workerId },
      select: { areaId: true },
    });
    return rows.map((r) => r.areaId);
  }

  async removeAreas(
    workerId: string,
    areaIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (areaIds.length > 0) {
      await tx.workerPreferredArea.deleteMany({ where: { workerId, areaId: { in: areaIds } } });
    }
  }

  async addAreas(workerId: string, areaIds: string[], tx: Prisma.TransactionClient): Promise<void> {
    if (areaIds.length > 0) {
      await tx.workerPreferredArea.createMany({
        data: areaIds.map((areaId) => ({ workerId, areaId })),
        skipDuplicates: true,
      });
    }
  }

  async currentWindows(
    workerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<TimeWindowMinutes[]> {
    return tx.workerTimeWindow.findMany({
      where: { workerId },
      select: { startMinute: true, endMinute: true },
      orderBy: { startMinute: 'asc' },
    });
  }

  async replaceWindows(
    workerId: string,
    windows: TimeWindowMinutes[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workerTimeWindow.deleteMany({ where: { workerId } });
    await tx.workerTimeWindow.createMany({
      data: windows.map((w) => ({ workerId, startMinute: w.startMinute, endMinute: w.endMinute })),
    });
  }
}
