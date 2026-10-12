import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/** The only place that touches `customer_shortlist_items`. Every query is scoped to one customer id. */
@Injectable()
export class ShortlistRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /** Serialises one customer's shortlist changes so the size cap cannot be raced. */
  async lockCustomer(customerUserId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shortlist:${customerUserId}`}, 0))`;
  }

  count(customerUserId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.customerShortlistItem.count({ where: { customerUserId } });
  }

  async add(customerUserId: string, workerId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.customerShortlistItem.createMany({
      data: [{ customerUserId, workerId }],
      skipDuplicates: true,
    });
  }

  has(customerUserId: string, workerId: string, tx: Prisma.TransactionClient): Promise<boolean> {
    return tx.customerShortlistItem
      .count({ where: { customerUserId, workerId } })
      .then((n) => n > 0);
  }

  async remove(customerUserId: string, workerId: string): Promise<number> {
    const result = await this.prisma.customerShortlistItem.deleteMany({
      where: { customerUserId, workerId },
    });
    return result.count;
  }

  async list(
    customerUserId: string,
    skip: number,
    take: number,
  ): Promise<{ items: Array<{ workerId: string; createdAt: Date }>; total: number }> {
    const where = { customerUserId };
    const [items, total] = await Promise.all([
      this.prisma.customerShortlistItem.findMany({
        where,
        select: { workerId: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { workerId: 'desc' }],
        skip,
        take,
      }),
      this.prisma.customerShortlistItem.count({ where }),
    ]);
    return { items, total };
  }
}
