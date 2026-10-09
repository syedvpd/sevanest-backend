import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { RatingStatusValue } from './dto/ratings.dto';

type Db = Prisma.TransactionClient | PrismaService;

export interface RatingRecord {
  id: string;
  bookingId: string;
  customerUserId: string;
  workerId: string;
  score: number;
  reviewText: string | null;
  status: RatingStatusValue;
  moderatedByUserId: string | null;
  moderatedAt: Date | null;
  moderationReason: string | null;
  createdAt: Date;
}

export interface RatingFilter {
  customerUserId?: string;
  workerId?: string;
  bookingId?: string;
  status?: RatingStatusValue;
}

/** The only place that touches `ratings` and `worker_rating_summaries`. */
@Injectable()
export class RatingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  create(
    input: {
      bookingId: string;
      customerUserId: string;
      workerId: string;
      score: number;
      reviewText: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<RatingRecord> {
    return tx.rating.create({ data: input });
  }

  findById(id: string, db: Db = this.prisma): Promise<RatingRecord | null> {
    return db.rating.findUnique({ where: { id } });
  }

  findByBooking(bookingId: string, db: Db = this.prisma): Promise<RatingRecord | null> {
    return db.rating.findUnique({ where: { bookingId } });
  }

  async lock(id: string, tx: Prisma.TransactionClient): Promise<RatingRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM ratings WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1 ? this.findById(id, tx) : null;
  }

  async moderate(
    id: string,
    change: {
      status: RatingStatusValue;
      moderatedByUserId: string;
      moderatedAt: Date;
      moderationReason: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.rating.update({ where: { id }, data: change });
  }

  async list(
    filter: RatingFilter,
    skip: number,
    take: number,
  ): Promise<{ items: RatingRecord[]; total: number }> {
    const where: Prisma.RatingWhereInput = {
      ...(filter.customerUserId ? { customerUserId: filter.customerUserId } : {}),
      ...(filter.workerId ? { workerId: filter.workerId } : {}),
      ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.rating.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.rating.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Adjusts the worker's running totals by a delta in ONE atomic statement (row lock on the summary row), so concurrent
   * ratings and moderations never lose an update and nothing ever scans the ratings table to build a profile average.
   */
  async adjustSummary(
    workerId: string,
    countDelta: number,
    sumDelta: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (countDelta < 0) {
      // A removal only ever follows an addition, so the row exists. (An upsert would be rejected by the non-negative CHECK,
      // which PostgreSQL evaluates on the proposed insert row before it looks for the conflict.)
      await tx.$executeRaw`
        UPDATE worker_rating_summaries SET
          rating_count = rating_count + ${countDelta},
          rating_sum = rating_sum + ${sumDelta},
          updated_at = now()
        WHERE worker_id = ${workerId}::uuid`;
      return;
    }
    await tx.$executeRaw`
      INSERT INTO worker_rating_summaries (worker_id, rating_count, rating_sum, updated_at)
      VALUES (${workerId}::uuid, ${countDelta}, ${sumDelta}, now())
      ON CONFLICT (worker_id) DO UPDATE SET
        rating_count = worker_rating_summaries.rating_count + EXCLUDED.rating_count,
        rating_sum = worker_rating_summaries.rating_sum + EXCLUDED.rating_sum,
        updated_at = now()`;
  }

  summaries(
    workerIds: string[],
  ): Promise<Array<{ workerId: string; ratingCount: number; ratingSum: number }>> {
    if (workerIds.length === 0) return Promise.resolve([]);
    return this.prisma.workerRatingSummary.findMany({
      where: { workerId: { in: workerIds } },
      select: { workerId: true, ratingCount: true, ratingSum: true },
    });
  }
}
