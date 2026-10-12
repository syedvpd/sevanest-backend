import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export type Channel = 'PUSH' | 'SMS' | 'WHATSAPP' | 'IN_APP';
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface TemplateRecord {
  id: string;
  eventCode: string;
  channel: Channel;
  language: string;
  title: string | null;
  body: string;
  dltTemplateId: string | null;
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
  readAt: Date | null;
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
      dltTemplateId?: string | null;
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
    data: {
      title?: string | null;
      body?: string;
      isActive?: boolean;
      dltTemplateId?: string | null;
    },
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
    languages: string[],
    tx: Prisma.TransactionClient,
  ): Promise<TemplateRecord[]> {
    return tx.notificationTemplate.findMany({
      where: { eventCode, language: { in: languages }, isActive: true },
    });
  }

  /** Preferred language of each user (worker or customer profile); users without a profile or a preference are absent. */
  async preferredLanguages(
    userIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<Array<{ user_id: string; lang: string | null }>>`
      SELECT u.id AS user_id, COALESCE(wp.preferred_language, cp.preferred_language) AS lang
      FROM users u
      LEFT JOIN worker_profiles wp ON wp.user_id = u.id
      LEFT JOIN customer_profiles cp ON cp.user_id = u.id
      WHERE u.id = ANY(${userIds}::uuid[])`;
    return new Map(rows.filter((r) => r.lang).map((r) => [r.user_id, r.lang!]));
  }

  async upsertDefaultTemplate(
    input: {
      eventCode: string;
      channel: Channel;
      language: string;
      title: string | null;
      body: string;
    },
    db: Db = this.prisma,
  ): Promise<boolean> {
    const existing = await db.notificationTemplate.findUnique({
      where: {
        eventCode_channel_language: {
          eventCode: input.eventCode,
          channel: input.channel,
          language: input.language,
        },
      },
    });
    if (existing) return false; // an administrator's wording is never overwritten
    await db.notificationTemplate.create({ data: { ...input, isActive: true } });
    return true;
  }

  // --- in-app inbox ------------------------------------------------------------------------------------------

  async listInbox(
    userId: string,
    filter: { unreadOnly: boolean },
    skip: number,
    take: number,
  ): Promise<{
    items: Array<NotificationRecord & { template: TemplateRecord | null }>;
    total: number;
  }> {
    const where: Prisma.NotificationWhereInput = {
      recipientUserId: userId,
      channel: 'IN_APP',
      status: 'SENT',
      ...(filter.unreadOnly ? { readAt: null } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        include: { template: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({ ...toNotification(r), template: r.template })),
      total,
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientUserId: userId, channel: 'IN_APP', status: 'SENT', readAt: null },
    });
  }

  /** Marks one of the user's own inbox items read. false = not theirs / not an inbox item / unknown. Repeating is harmless. */
  async markRead(userId: string, id: string): Promise<boolean> {
    const found = await this.prisma.notification.findFirst({
      where: { id, recipientUserId: userId, channel: 'IN_APP' },
      select: { id: true },
    });
    if (!found) return false;
    await this.prisma.notification.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    });
    return true;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { recipientUserId: userId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
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
      /** IN_APP notifications are born SENT: the row is the message. */
      delivered?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const status = input.delivered ? 'SENT' : 'QUEUED';
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO notifications (id, outbox_event_id, recipient_user_id, event_code, channel, template_id, params, status, sent_at, dedupe_key, updated_at)
      VALUES (gen_random_uuid(), ${input.outboxEventId}::uuid, ${input.recipientUserId}::uuid, ${input.eventCode},
              ${input.channel}::"NotificationChannel", ${input.templateId}::uuid, ${JSON.stringify(input.params)}::jsonb,
              ${status}::"NotificationStatus", ${input.delivered ? new Date() : null}::timestamptz,
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

  async statusCounts(): Promise<Record<DeliveryStatus, number>> {
    const groups = await this.prisma.notification.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts: Record<DeliveryStatus, number> = { QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 0 };
    for (const g of groups) counts[g.status] = g._count._all;
    return counts;
  }

  async oldestQueuedAgeSeconds(): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ age: number | null }>>`
      SELECT EXTRACT(EPOCH FROM now() - min(created_at))::float8 AS age FROM notifications WHERE status = 'QUEUED'`;
    const age = rows[0]?.age;
    return age === null || age === undefined ? null : Math.floor(age);
  }

  /** FAILED -> QUEUED for a manual retry; null when the notification is not FAILED (or does not exist). */
  async requeueFailed(id: string): Promise<{ attempts: number } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ attempts: number }>>`
      UPDATE notifications SET status = 'QUEUED', last_error = NULL, updated_at = now()
      WHERE id = ${id}::uuid AND status = 'FAILED' RETURNING attempts`;
    return rows[0] ?? null;
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
