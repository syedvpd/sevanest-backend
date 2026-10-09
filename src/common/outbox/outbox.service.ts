import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  NOTIFICATION_TOPIC,
  NotificationEventCode,
  NotificationOutboxPayload,
} from './notification-events';

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
      WHERE processed_at IS NULL
      ORDER BY created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
  }

  async markProcessed(ids: string[], tx: Prisma.TransactionClient): Promise<void> {
    if (ids.length === 0) return;
    await tx.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { processedAt: new Date() },
    });
  }
}
