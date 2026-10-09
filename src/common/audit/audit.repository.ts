import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { AuditTransaction } from './audit.types';

export interface AuditSearchFilter {
  action?: string;
  actionPrefix?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  requestId?: string;
  /** Inclusive lower and exclusive upper bound. */
  from?: Date;
  to?: Date;
}

export interface AuditLogRecord {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Prisma.JsonValue | null;
  requestId: string | null;
  createdAt: Date;
}

/** Insert-only for writers (the table rejects UPDATE/DELETE/TRUNCATE at the database level); `search` is the read side for the audit viewer. */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest-first, deterministic (created_at, id). Every filter is a column that has an index. */
  async search(
    filter: AuditSearchFilter,
    skip: number,
    take: number,
  ): Promise<{ items: AuditLogRecord[]; total: number }> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.actionPrefix ? { action: { startsWith: filter.actionPrefix } } : {}),
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.actorId ? { actorId: filter.actorId } : {}),
      ...(filter.requestId ? { requestId: filter.requestId } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lt: filter.to } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total };
  }

  async insert(data: Prisma.AuditLogUncheckedCreateInput, tx?: AuditTransaction): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({ data, select: { id: true } });
  }
}
