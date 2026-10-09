import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export interface CategoryRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ServiceCategorySelect;

/** The only place that reads or writes `service_categories`. */
@Injectable()
export class ServiceCategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  findById(id: string, db: Db = this.prisma): Promise<CategoryRecord | null> {
    return db.serviceCategory.findUnique({ where: { id }, select: SELECT });
  }

  findByCode(code: string): Promise<CategoryRecord | null> {
    return this.prisma.serviceCategory.findUnique({ where: { code }, select: SELECT });
  }

  findByIds(ids: string[], db: Db = this.prisma): Promise<CategoryRecord[]> {
    return db.serviceCategory.findMany({ where: { id: { in: ids } }, select: SELECT });
  }

  async list(
    filter: { enabled?: boolean },
    skip: number,
    take: number,
  ): Promise<{ items: CategoryRecord[]; total: number }> {
    const where: Prisma.ServiceCategoryWhereInput =
      filter.enabled === undefined ? {} : { isEnabled: filter.enabled };
    const [items, total] = await Promise.all([
      this.prisma.serviceCategory.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take,
        select: SELECT,
      }),
      this.prisma.serviceCategory.count({ where }),
    ]);
    return { items, total };
  }

  create(
    data: { code: string; name: string; description: string | null },
    db: Db = this.prisma,
  ): Promise<CategoryRecord> {
    return db.serviceCategory.create({ data, select: SELECT });
  }

  /** Locks the row for the rest of the transaction so concurrent admin edits serialise. */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<CategoryRecord | null> {
    await tx.$queryRaw`SELECT id FROM service_categories WHERE id = ${id}::uuid FOR UPDATE`;
    return this.findById(id, tx);
  }

  update(
    id: string,
    data: { name?: string; description?: string | null; isEnabled?: boolean },
    tx: Prisma.TransactionClient,
  ): Promise<CategoryRecord> {
    return tx.serviceCategory.update({ where: { id }, data, select: SELECT });
  }
}
