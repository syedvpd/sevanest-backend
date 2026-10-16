import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

export interface RetentionContext {
  /** True = count what would be removed, change nothing. */
  dryRun: boolean;
  /** Technical cap per task per run, so a first run on a large table cannot hold locks for long. */
  batchSize: number;
  now: Date;
}

export interface RetentionOutcome {
  /** Rows (or objects) past their retention period. */
  matched: number;
  /** Rows (or objects) actually removed or purged this run; 0 in a dry run. */
  affected: number;
}

/** A time-based clean-up owned by the module that owns the data (DEC-08). Must be idempotent and must never touch audit logs or payments. */
export interface RetentionTask {
  name: string;
  run(context: RetentionContext): Promise<RetentionOutcome>;
}

/**
 * Anonymises one module's personal data of one user inside the deletion transaction (DEC-08). Returns the storage object keys it
 * orphaned; the caller deletes them after the commit. Bookings, payments, ratings and audit records are never touched: they keep pointing
 * at the (now anonymous) user id.
 */
export interface PersonalDataEraser {
  name: string;
  erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }>;
}

/**
 * Owners register their retention tasks and erasers at startup (the same one-way pattern as the booking hooks), so the Retention module
 * and Legal never import the modules whose data they clean.
 */
@Injectable()
export class RetentionRegistry {
  private readonly taskList: RetentionTask[] = [];
  private readonly eraserList: PersonalDataEraser[] = [];

  registerTask(task: RetentionTask): void {
    this.taskList.push(task);
  }

  registerEraser(eraser: PersonalDataEraser): void {
    this.eraserList.push(eraser);
  }

  get tasks(): readonly RetentionTask[] {
    return this.taskList;
  }

  get erasers(): readonly PersonalDataEraser[] {
    return this.eraserList;
  }
}

@Global()
@Module({ providers: [RetentionRegistry], exports: [RetentionRegistry] })
export class RetentionRegistryModule {}
