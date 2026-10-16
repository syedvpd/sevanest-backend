import { Injectable, OnModuleInit } from '@nestjs/common';
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

/** DEC-08: delivered or abandoned notification rows are kept NOTIFICATIONS_MONTHS months; a queued one is never removed. An erased account loses its inbox. */
@Injectable()
export class NotificationsRetention implements OnModuleInit, RetentionTask, PersonalDataEraser {
  readonly name = 'notifications';

  constructor(
    private readonly registry: RetentionRegistry,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.registerTask(this);
    this.registry.registerEraser(this);
  }

  async run(context: RetentionContext): Promise<RetentionOutcome> {
    const months = this.config.retention.notificationsMonths;
    const cutoff = new Date(context.now);
    cutoff.setMonth(cutoff.getMonth() - months);
    const ids = await this.prisma.notification.findMany({
      where: { createdAt: { lt: cutoff }, status: { in: ['SENT', 'FAILED', 'SKIPPED'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: context.batchSize,
    });
    if (context.dryRun || ids.length === 0) return { matched: ids.length, affected: 0 };
    const removed = await this.prisma.notification.deleteMany({
      where: { id: { in: ids.map((i) => i.id) } },
    });
    return { matched: ids.length, affected: removed.count };
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    await tx.notification.deleteMany({ where: { recipientUserId: userId } });
    return { objectKeys: [] };
  }
}
