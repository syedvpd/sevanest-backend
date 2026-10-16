import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type PersonalDataEraser,
  type RetentionContext,
  type RetentionOutcome,
  type RetentionTask,
} from '../../common/retention/retention.registry';
import { AppConfigService } from '../../config/app-config.service';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../integrations/storage/storage-provider.interface';

/**
 * DEC-08 for KYC material. (1) Files of REJECTED checks are deleted KYC_REJECTED_DAYS after the rejection (the row stays, marked purged). (2) When an
 * account is erased every stored KYC file of the worker is purged. Documents of an approved check are never touched by the time-based task.
 */
@Injectable()
export class VerificationRetention implements OnModuleInit, RetentionTask, PersonalDataEraser {
  readonly name = 'verification';
  private readonly logger = new Logger(VerificationRetention.name);

  constructor(
    private readonly registry: RetentionRegistry,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    this.registry.registerTask(this);
    this.registry.registerEraser(this);
  }

  async run(context: RetentionContext): Promise<RetentionOutcome> {
    const cutoff = new Date(
      context.now.getTime() - this.config.retention.kycRejectedDays * 86_400_000,
    );
    const rows = await this.prisma.$queryRaw<Array<{ id: string; object_key: string }>>`
      SELECT d.id, d.object_key FROM verification_documents d
      JOIN worker_verification_checks c ON c.id = d.check_id
      WHERE c.status = 'REJECTED' AND d.purged_at IS NULL AND c.updated_at < ${cutoff}
      ORDER BY c.updated_at
      LIMIT ${context.batchSize}`;
    if (context.dryRun || rows.length === 0) return { matched: rows.length, affected: 0 };
    let affected = 0;
    for (const row of rows) {
      try {
        await this.storage.deleteObject(row.object_key);
        await this.prisma.verificationDocument.update({
          where: { id: row.id },
          data: { purgedAt: new Date(), rejectionCode: 'RETENTION_EXPIRED' },
        });
        affected++;
      } catch (error) {
        this.logger.warn(`Rejected KYC file could not be purged: ${(error as Error).message}`);
      }
    }
    return { matched: rows.length, affected };
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    const rows = await tx.$queryRaw<Array<{ id: string; object_key: string }>>`
      SELECT d.id, d.object_key FROM verification_documents d
      JOIN worker_verification_checks c ON c.id = d.check_id
      JOIN worker_profiles wp ON wp.id = c.worker_id
      WHERE wp.user_id = ${userId}::uuid AND d.purged_at IS NULL`;
    if (rows.length > 0) {
      await tx.verificationDocument.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { purgedAt: new Date(), rejectionCode: 'ACCOUNT_ERASED' },
      });
    }
    return { objectKeys: rows.map((r) => r.object_key) };
  }
}
