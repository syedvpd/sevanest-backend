import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { AuditTransaction } from './audit.types';

/** Insert-only: the audit_logs table rejects UPDATE/DELETE/TRUNCATE at the database level. */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(data: Prisma.AuditLogUncheckedCreateInput, tx?: AuditTransaction): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({ data, select: { id: true } });
  }
}
