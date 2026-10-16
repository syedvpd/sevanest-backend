import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RetentionRegistry } from '../../common/retention/retention.registry';
import { AppConfigService } from '../../config/app-config.service';
import { LegalService, type DeletionRunResult } from '../legal/legal.service';

export interface RetentionReport {
  dryRun: boolean;
  tasks: Array<{ name: string; matched: number; affected: number; failed?: boolean }>;
  deletions: DeletionRunResult;
}

/**
 * DEC-08: runs every registered retention task and the account anonymisation. A task that fails never stops the others. Audit logs,
 * payments, receipts and bookings are not in any task (their owners register none), so they cannot be touched from here. A run that removed
 * anything is audited with counts only.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly registry: RetentionRegistry,
    private readonly legal: LegalService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  async runOnce(options: { dryRun?: boolean; audit?: boolean } = {}): Promise<RetentionReport> {
    const settings = this.config.retention;
    const dryRun = options.dryRun ?? settings.dryRun;
    const context = { dryRun, batchSize: settings.batchSize, now: new Date() };
    const tasks: RetentionReport['tasks'] = [];
    for (const task of this.registry.tasks) {
      try {
        tasks.push({ name: task.name, ...(await task.run(context)) });
      } catch (error) {
        this.logger.error(`Retention task ${task.name} failed: ${(error as Error).message}`);
        tasks.push({ name: task.name, matched: 0, affected: 0, failed: true });
      }
    }
    const deletions = await this.legal
      .processDueDeletions({ dryRun, batchSize: settings.batchSize })
      .catch((error: unknown) => {
        this.logger.error(`Deletion processing failed: ${(error as Error).message}`);
        return { due: 0, anonymised: 0, blocked: 0, failed: 1 } satisfies DeletionRunResult;
      });
    const report: RetentionReport = { dryRun, tasks, deletions };
    const touched = tasks.some((t) => t.affected > 0) || deletions.anonymised > 0;
    if (options.audit !== false && !dryRun && touched) {
      await this.audit.record({
        action: 'retention.run',
        entityType: 'retention',
        actorId: null,
        metadata: { tasks: tasks.map((t) => ({ name: t.name, affected: t.affected })), deletions },
      });
    }
    return report;
  }
}
