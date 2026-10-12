import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface PhotoRecord {
  id: string;
  workerId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  status: 'PENDING_UPLOAD' | 'READY';
}

const SELECT = {
  id: true,
  workerId: true,
  objectKey: true,
  contentType: true,
  sizeBytes: true,
  status: true,
} as const;

/** The only place that touches `worker_profile_photos`. */
@Injectable()
export class WorkerPhotoRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  create(
    data: { workerId: string; objectKey: string; contentType: string; sizeBytes: number },
    tx: Prisma.TransactionClient,
  ): Promise<PhotoRecord> {
    return tx.workerProfilePhoto.create({ data, select: SELECT });
  }

  /** Serialises uploads and confirmations of one worker's photos. */
  async lockWorker(workerId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`worker-photo:${workerId}`}, 0))`;
  }

  countPending(workerId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workerProfilePhoto.count({ where: { workerId, status: 'PENDING_UPLOAD' } });
  }

  find(id: string, tx?: Prisma.TransactionClient): Promise<PhotoRecord | null> {
    return (tx ?? this.prisma).workerProfilePhoto.findUnique({ where: { id }, select: SELECT });
  }

  async markReady(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.workerProfilePhoto.update({
      where: { id },
      data: { status: 'READY', confirmedAt: new Date() },
    });
  }

  /** Newest READY photo of each worker (one statement). */
  async currentKeys(workerIds: string[]): Promise<Map<string, string>> {
    if (workerIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ workerId: string; objectKey: string }>>`
      SELECT DISTINCT ON (worker_id) worker_id AS "workerId", object_key AS "objectKey"
      FROM worker_profile_photos
      WHERE worker_id = ANY(${workerIds}::uuid[]) AND status = 'READY'
      ORDER BY worker_id, confirmed_at DESC, id DESC`;
    return new Map(rows.map((r) => [r.workerId, r.objectKey]));
  }
}
