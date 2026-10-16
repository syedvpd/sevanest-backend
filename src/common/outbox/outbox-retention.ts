import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type RetentionContext,
  type RetentionOutcome,
  type RetentionTask,
} from '../retention/retention.registry';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * DEC-08: processed outbox events are kept OUTBOX_DAYS days. An event that still has notification rows stays until those rows are gone (they
 * reference it); an unprocessed or dead-lettered event is never removed.
 */
@Injectable()
export class OutboxRetention implements OnModuleInit, RetentionTask {
  readonly name = 'outbox';

  constructor(
    private readonly registry: RetentionRegistry,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.registerTask(this);
  }

  async run(context: RetentionContext): Promise<RetentionOutcome> {
    const cutoff = new Date(context.now.getTime() - this.config.retention.outboxDays * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT e.id FROM outbox_events e
      WHERE e.processed_at IS NOT NULL AND e.processed_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.outbox_event_id = e.id)
      ORDER BY e.processed_at
      LIMIT ${context.batchSize}`;
    if (context.dryRun || rows.length === 0) return { matched: rows.length, affected: 0 };
    const removed = await this.prisma.outboxEvent.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    return { matched: rows.length, affected: removed.count };
  }
}
