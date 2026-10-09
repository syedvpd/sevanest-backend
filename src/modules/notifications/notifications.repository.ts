import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export type Channel = 'PUSH' | 'SMS' | 'WHATSAPP';
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface TemplateRecord {
  id: string;
  eventCode: string;
  channel: Channel;
  language: string;
  title: string | null;
  body: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationRecord {
  id: string;
  outboxEventId: string;
  recipientUserId: string;
  eventCode: string;
  channel: Channel;
  templateId: string | null;
  params: Record<string, string>;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

function toNotification(row: Prisma.NotificationGetPayload<object>): NotificationRecord {
  return { ...row, params: row.params as Record<string, string> };
}

/** The only place that touches the notification tables (the outbox itself belongs to the shared OutboxService). */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // --- templates --------------------------------------------------------------------------------------------

  createTemplate(
    input: {
      eventCode: string;
      channel: Channel;
      language: string;
      title: string | null;
      body: string;
      isActive: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<TemplateRecord> {
    return tx.notificationTemplate.create({ data: input });
  }

  findTemplate(id: string, db: Db = this.prisma): Promise<TemplateRecord | null> {
    return db.notificationTemplate.findUnique({ where: { id } });
  }

  updateTemplate(
    id: string,
    data: { title?: string | null; body?: string; isActive?: boolean },
    tx: Prisma.TransactionClient,
  ): Promise<TemplateRecord> {
    return tx.notificationTemplate.update({ where: { id }, data });
  }

  async listTemplates(
    filter: { eventCode?: string },
    skip: number,
    take: number,
  ): Promise<{ items: TemplateRecord[]; total: number }> {
    const where = filter.eventCode ? { eventCode: filter.eventCode } : {};
    const [items, total] = await Promise.all([
      this.prisma.notificationTemplate.findMany({
        where,
        orderBy: [{ eventCode: 'asc' }, { channel: 'asc' }, { language: 'asc' }],
        skip,
        take,
      }),
      this.prisma.notificationTemplate.count({ where }),
    ]);
    return { items, total };
  }

  activeTemplatesFor(
    eventCode: string,
    language: string,
    tx: Prisma.TransactionClient,
  ): Promise<TemplateRecord[]> {
    return tx.notificationTemplate.findMany({ where: { eventCode, language, isActive: true } });
  }

  // --- notifications ----------------------------------------------------------------------------------------

  /** Inserts a queued notification unless one with this dedupe key exists. Returns the new id, or null for a duplicate. */
  async insertQueued(
    input: {
      outboxEventId: string;
      recipientUserId: string;
      eventCode: string;
      channel: Channel;
      templateId: string;
      params: Record<string, string>;
      dedupeKey: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO notifications (id, outbox_event_id, recipient_user_id, event_code, channel, template_id, params, dedupe_key, updated_at)
      VALUES (gen_random_uuid(), ${input.outboxEventId}::uuid, ${input.recipientUserId}::uuid, ${input.eventCode},
              ${input.channel}::"NotificationChannel", ${input.templateId}::uuid, ${JSON.stringify(input.params)}::jsonb,
              ${input.dedupeKey}, now())
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  async findById(id: string, db: Db = this.prisma): Promise<NotificationRecord | null> {
    const row = await db.notification.findUnique({ where: { id } });
    return row ? toNotification(row) : null;
  }

  async findTemplateById(id: string | null, db: Db = this.prisma): Promise<TemplateRecord | null> {
    return id ? this.findTemplate(id, db) : null;
  }

  /**
   * Runs `work` while holding a per-notification lock, so two workers can never send the same notification at once.
   * Returns null without running `work` if another worker holds it.
   */
  async withDeliveryLock<T>(id: string, work: () => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${`notification:${id}`}, 0)) AS locked`;
        return rows[0]?.locked ? work() : null;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  async markAttempt(id: string, error: string | null): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error },
    });
  }

  /** Only a QUEUED notification can finish; a second finisher changes nothing. */
  async finish(
    id: string,
    result: {
      status: Exclude<DeliveryStatus, 'QUEUED'>;
      lastError?: string | null;
      providerMessageId?: string | null;
    },
  ): Promise<boolean> {
    const updated = await this.prisma.notification.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: result.status,
        lastError: result.lastError ?? null,
        providerMessageId: result.providerMessageId ?? null,
        sentAt: result.status === 'SENT' ? new Date() : null,
      },
    });
    return updated.count === 1;
  }

  async staleQueuedIds(olderThanSeconds: number, limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM notifications
      WHERE status = 'QUEUED' AND created_at < now() - make_interval(secs => ${olderThanSeconds})
      ORDER BY created_at, id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  async list(
    filter: { status?: DeliveryStatus; eventCode?: string; recipientUserId?: string },
    skip: number,
    take: number,
  ): Promise<{ items: NotificationRecord[]; total: number }> {
    const where: Prisma.NotificationWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.eventCode ? { eventCode: filter.eventCode } : {}),
      ...(filter.recipientUserId ? { recipientUserId: filter.recipientUserId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { items: rows.map(toNotification), total };
  }
}
