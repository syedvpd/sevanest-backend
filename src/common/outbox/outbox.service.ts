import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  NOTIFICATION_TOPIC,
  NotificationEventCode,
  NotificationOutboxPayload,
} from './notification-events';

/** Engineering default (not a business rule): attempts before an event is dead-lettered. */
export const MAX_DISPATCH_ATTEMPTS = 5;

export interface PendingOutboxEvent {
  id: string;
  topic: string;
  payload: unknown;
}

/**
 * Transactional outbox (BEA p8: transition + side effects commit atomically, notify after commit). Producers call
 * `notify` with the surrounding transaction, so the event exists if and only if the business change committed.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  /** Records "tell these users about this event" in the caller's transaction. Recipients are de-duplicated. */
  async notify(
    input: { event: NotificationEventCode; recipients: string[]; params: Record<string, string> },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const recipients = [...new Set(input.recipients)];
    if (recipients.length === 0) return;
    const payload: NotificationOutboxPayload = {
      event: input.event,
      recipients,
      params: input.params,
    };
    await tx.outboxEvent.create({
      data: { topic: NOTIFICATION_TOPIC, payload: payload as unknown as Prisma.InputJsonValue },
    });
  }

  /** Locks and returns unprocessed events; concurrent dispatchers skip rows another one holds. */
  claimPending(limit: number, tx: Prisma.TransactionClient): Promise<PendingOutboxEvent[]> {
    return tx.$queryRaw<PendingOutboxEvent[]>`
      SELECT id, topic, payload FROM outbox_events
      WHERE processed_at IS NULL AND failed_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
  }

  /**
   * Records a dispatch failure of one event (outside the failed transaction). After MAX_DISPATCH_ATTEMPTS the event is
   * dead-lettered (failed_at set) and no longer claimed; before that it is retried with exponential backoff. `code` is a stable
   * reason, never payload content.
   */
  async recordFailure(id: string, code: string): Promise<{ deadLettered: boolean }> {
    const rows = await this.prisma.$queryRaw<Array<{ failed: boolean }>>`
      UPDATE outbox_events SET
        attempts = attempts + 1,
        last_error = ${code},
        next_attempt_at = now() + (interval '5 seconds' * power(2, attempts)),
        failed_at = CASE WHEN attempts + 1 >= ${MAX_DISPATCH_ATTEMPTS} THEN now() ELSE NULL END
      WHERE id = ${id}::uuid AND processed_at IS NULL
      RETURNING failed_at IS NOT NULL AS failed`;
    return { deadLettered: rows[0]?.failed === true };
  }

  /** Puts a dead-lettered event back into the queue (manual recovery). false = not dead-lettered / unknown. */
  async retryDeadLettered(id: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE outbox_events SET failed_at = NULL, attempts = 0, last_error = NULL, next_attempt_at = NULL
      WHERE id = ${id}::uuid AND failed_at IS NOT NULL AND processed_at IS NULL RETURNING id`;
    return rows.length === 1;
  }

  /** Unprocessed events and the age of the oldest: a growing backlog means the worker process is stopped or failing. */
  async backlog(): Promise<{
    pending: number;
    oldestPendingSeconds: number | null;
    deadLettered: number;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ pending: bigint; oldest: number | null; dead: bigint }>
    >`
      SELECT count(*) FILTER (WHERE failed_at IS NULL) AS pending,
             EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE failed_at IS NULL))::float8 AS oldest,
             count(*) FILTER (WHERE failed_at IS NOT NULL) AS dead
      FROM outbox_events WHERE processed_at IS NULL`;
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      deadLettered: Number(row?.dead ?? 0),
      oldestPendingSeconds:
        row?.oldest === null || row?.oldest === undefined ? null : Math.floor(row.oldest),
    };
  }

  async markProcessed(ids: string[], tx: Prisma.TransactionClient): Promise<void> {
    if (ids.length === 0) return;
    await tx.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { processedAt: new Date() },
    });
  }
}
