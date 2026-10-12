import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import {
  EVENT_PARAMS,
  NOTIFICATION_TOPIC,
  NotificationEventCode,
  NotificationOutboxPayload,
} from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import { ProviderError } from '../../integrations/provider-error';
import {
  PUSH_PROVIDER,
  SMS_PROVIDER,
  WHATSAPP_PROVIDER,
  type PushProvider,
  type SmsProvider,
  type WhatsAppProvider,
} from '../../integrations/notifications/notification-providers.interface';
import { SessionService } from '../auth/session.service';
import type { Actor } from '../users/users.types';
import { UsersService } from '../users/users.service';
import {
  CreateTemplateDto,
  DeliveryListQuery,
  DeliveryView,
  EventView,
  InboxItemView,
  InboxQuery,
  TemplateListQuery,
  TemplateView,
  UpdateTemplateDto,
} from './dto/notifications.dto';
import { NOTIFICATION_QUEUE } from './notifications.constants';
import {
  NotificationRecord,
  NotificationsRepository,
  TemplateRecord,
} from './notifications.repository';

export interface HealthView {
  notifications: {
    byStatus: Record<'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED', number>;
    oldestQueuedSeconds: number | null;
  };
  outbox: { pending: number; oldestPendingSeconds: number | null; deadLettered: number };
  queue: { waiting: number; active: number; delayed: number; failed: number } | null;
}

export const DEFAULT_LANGUAGE = 'en';
const OUTBOX_BATCH = 50;
/** A queued notification nobody picked up after this long is handed to the queue again (the job id keeps it single). */
const STALE_AFTER_SECONDS = 60;

export const NotificationErrorCode = {
  UNKNOWN_EVENT: 'UNKNOWN_EVENT',
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  TEMPLATE_EXISTS: 'TEMPLATE_EXISTS',
  UNKNOWN_PLACEHOLDER: 'UNKNOWN_PLACEHOLDER',
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  NOTIFICATION_NOT_FAILED: 'NOTIFICATION_NOT_FAILED',
  OUTBOX_EVENT_NOT_DEAD_LETTERED: 'OUTBOX_EVENT_NOT_DEAD_LETTERED',
} as const;

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** Where a tap on an inbox item should lead, from the ids in its parameters (deep link). */
export function routeFor(params: Record<string, string>): { type: string; id: string } | null {
  if (params.bookingId) return { type: 'booking', id: params.bookingId };
  if (params.ticketId) return { type: 'ticket', id: params.ticketId };
  if (params.replacementId) return { type: 'replacement', id: params.replacementId };
  if (params.paymentId) return { type: 'payment', id: params.paymentId };
  return null;
}

export function render(text: string, params: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_all, name: string) => params[name] ?? '');
}

/**
 * Notification delivery (SRS 3.15). Business modules write events to the transactional outbox in their own transaction;
 * this service turns each event into one `notifications` row per recipient and configured channel (deduplicated), queues
 * delivery on BullMQ, and a worker delivers through the provider adapters. Delivery is at-least-once with a per-notification
 * idempotency key; a notification can finish only once. A failing provider never touches the business transaction.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly outbox: OutboxService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
  ) {}

  // --- outbox -> notifications -> queue ---------------------------------------------------------------------

  /** Converts pending outbox events into queued notifications and hands them to the queue. Safe to run concurrently. */
  async dispatchOutbox(): Promise<{ events: number; queued: number }> {
    const ids: string[] = [];
    let events = 0;
    // One event per transaction: a poison event (malformed payload, bug) rolls back only itself, is retried with backoff and
    // then dead-lettered, instead of blocking every event behind it forever.
    for (let i = 0; i < OUTBOX_BATCH; i += 1) {
      let currentId: string | undefined;
      try {
        const more = await this.repository.transaction(async (tx) => {
          const [event] = await this.outbox.claimPending(1, tx);
          if (!event) return false;
          currentId = event.id;
          events += 1;
          if (event.topic === NOTIFICATION_TOPIC) {
            ids.push(...(await this.expand(event, tx)));
          }
          await this.outbox.markProcessed([event.id], tx);
          return true;
        });
        if (!more) break;
      } catch (error) {
        if (!currentId) throw error; // infrastructure failure before an event was claimed: not the event's fault
        const result = await this.outbox.recordFailure(currentId, 'DISPATCH_ERROR');
        this.logger.error(
          `Outbox event ${currentId} failed to dispatch (${result.deadLettered ? 'dead-lettered' : 'will retry'}): ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    await this.enqueue(ids);
    return { events, queued: ids.length };
  }

  private async expand(
    event: { id: string; payload: unknown },
    tx: Parameters<Parameters<NotificationsRepository['transaction']>[0]>[0],
  ): Promise<string[]> {
    const payload = event.payload as NotificationOutboxPayload;
    const languages = await this.repository.preferredLanguages(payload.recipients, tx);
    const wanted = [...new Set([DEFAULT_LANGUAGE, ...languages.values()])];
    const templates = await this.repository.activeTemplatesFor(payload.event, wanted, tx);
    const created: string[] = [];
    for (const recipientUserId of payload.recipients) {
      // The recipient's own language where a template exists for that channel, otherwise the platform default.
      const own = languages.get(recipientUserId) ?? DEFAULT_LANGUAGE;
      const byChannel = new Map<string, TemplateRecord>();
      for (const template of templates) {
        if (template.language === DEFAULT_LANGUAGE && !byChannel.has(template.channel)) {
          byChannel.set(template.channel, template);
        }
      }
      for (const template of templates) {
        if (template.language === own) byChannel.set(template.channel, template);
      }
      for (const template of byChannel.values()) {
        const inApp = template.channel === 'IN_APP';
        const id = await this.repository.insertQueued(
          {
            outboxEventId: event.id,
            recipientUserId,
            eventCode: payload.event,
            channel: template.channel,
            templateId: template.id,
            params: payload.params,
            dedupeKey: `${event.id}:${recipientUserId}:${template.channel}`,
            delivered: inApp,
          },
          tx,
        );
        // An in-app message is complete once its row exists; only provider channels go to the queue.
        if (id && !inApp) created.push(id);
      }
    }
    return created;
  }

  /** Re-offers notifications that are still QUEUED long after they were created (queue outage, lost job). */
  async requeueStale(): Promise<number> {
    const ids = await this.repository.staleQueuedIds(STALE_AFTER_SECONDS, 100);
    await this.enqueue(ids);
    return ids.length;
  }

  private async enqueue(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        // jobId = notification id: offering the same notification twice never creates two jobs.
        await this.queue.add('deliver', { notificationId: id }, { jobId: id });
      } catch (error) {
        this.logger.warn(`Could not queue notification ${id}; it stays QUEUED for the next sweep`);
        void error;
      }
    }
  }

  // --- delivery (called by the worker) ----------------------------------------------------------------------

  /**
   * Delivers one notification. A retryable provider failure is rethrown so the queue retries with backoff; after the last
   * attempt, or for a permanent failure, the notification is FAILED. Repeating a finished notification does nothing.
   */
  async deliver(
    notificationId: string,
    attempt: { number: number; max: number } = { number: 1, max: 1 },
  ): Promise<'SENT' | 'FAILED' | 'SKIPPED' | 'ALREADY_DONE' | 'RETRY'> {
    const locked = await this.repository.withDeliveryLock(notificationId, () =>
      this.deliverLocked(notificationId, attempt),
    );
    return locked ?? 'ALREADY_DONE';
  }

  private async deliverLocked(
    notificationId: string,
    attempt: { number: number; max: number },
  ): Promise<'SENT' | 'FAILED' | 'SKIPPED' | 'ALREADY_DONE'> {
    const notification = await this.repository.findById(notificationId);
    if (!notification || notification.status !== 'QUEUED') return 'ALREADY_DONE';
    const target = await this.resolveTarget(notification);
    if (target.kind === 'skip') {
      await this.repository.finish(notification.id, {
        status: 'SKIPPED',
        lastError: target.reason,
      });
      return 'SKIPPED';
    }
    try {
      const providerMessageId = await this.send(notification, target);
      await this.repository.markAttempt(notification.id, null);
      const done = await this.repository.finish(notification.id, {
        status: 'SENT',
        providerMessageId,
      });
      return done ? 'SENT' : 'ALREADY_DONE';
    } catch (error) {
      const retryable = !(error instanceof ProviderError) || error.retryable;
      await this.repository.markAttempt(
        notification.id,
        retryable ? 'PROVIDER_ERROR' : 'PROVIDER_REJECTED',
      );
      if (retryable && attempt.number < attempt.max) {
        throw error;
      }
      await this.repository.finish(notification.id, {
        status: 'FAILED',
        lastError: retryable ? 'PROVIDER_ERROR' : 'PROVIDER_REJECTED',
      });
      return 'FAILED';
    }
  }

  private async resolveTarget(
    notification: NotificationRecord,
  ): Promise<
    | { kind: 'skip'; reason: string }
    | { kind: 'send'; text: string; title: string; mobile: string | null; tokens: string[] }
  > {
    const [user, template] = await Promise.all([
      this.users.findById(notification.recipientUserId),
      this.repository.findTemplateById(notification.templateId),
    ]);
    if (!user || user.status !== 'ACTIVE') return { kind: 'skip', reason: 'RECIPIENT_INACTIVE' };
    if (!template || !template.isActive) return { kind: 'skip', reason: 'TEMPLATE_INACTIVE' };
    const text = render(template.body, notification.params);
    const title = render(template.title ?? '', notification.params);
    if (notification.channel === 'PUSH') {
      const tokens = await this.sessions.listDeviceTokens(user.id);
      return tokens.length === 0
        ? { kind: 'skip', reason: 'NO_DEVICE' }
        : { kind: 'send', text, title, mobile: null, tokens };
    }
    return user.mobile
      ? { kind: 'send', text, title, mobile: user.mobile, tokens: [] }
      : { kind: 'skip', reason: 'NO_MOBILE' };
  }

  private async send(
    notification: NotificationRecord,
    target: { text: string; title: string; mobile: string | null; tokens: string[] },
  ): Promise<string> {
    switch (notification.channel) {
      case 'SMS':
        return (
          await this.sms.sendSms({
            to: target.mobile!,
            body: target.text,
            idempotencyKey: notification.id,
          })
        ).providerMessageId;
      case 'WHATSAPP':
        return (
          await this.whatsapp.sendWhatsApp({
            to: target.mobile!,
            body: target.text,
            idempotencyKey: notification.id,
          })
        ).providerMessageId;
      default: {
        let last = '';
        for (const deviceToken of target.tokens) {
          last = (
            await this.push.sendPush({
              deviceToken,
              title: target.title,
              body: target.text,
              data: { notificationId: notification.id, event: notification.eventCode },
            })
          ).providerMessageId;
        }
        return last;
      }
    }
  }

  // --- admin: templates and delivery log --------------------------------------------------------------------

  events(): EventView[] {
    return Object.entries(EVENT_PARAMS).map(([eventCode, params]) => ({
      eventCode,
      params: [...params],
    }));
  }

  async createTemplate(
    dto: CreateTemplateDto,
    admin: Actor & { userId: string },
  ): Promise<TemplateView> {
    const params = this.paramsFor(dto.eventCode);
    this.assertPlaceholders([dto.body, dto.title ?? ''], params);
    try {
      const created = await this.repository.transaction(async (tx) => {
        const template = await this.repository.createTemplate(
          {
            eventCode: dto.eventCode,
            channel: dto.channel,
            language: dto.language ?? DEFAULT_LANGUAGE,
            title: dto.title ?? null,
            body: dto.body,
            dltTemplateId: dto.dltTemplateId ?? null,
            isActive: dto.isActive ?? true,
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'notification_template.create',
            entityType: 'notification_template',
            entityId: template.id,
            actorId: admin.userId,
            actorRole: admin.roles.join(',') || null,
            metadata: {
              eventCode: template.eventCode,
              channel: template.channel,
              language: template.language,
            },
          },
          tx,
        );
        return template;
      });
      return this.templateView(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          NotificationErrorCode.TEMPLATE_EXISTS,
          'A template for this event, channel and language already exists',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async updateTemplate(
    id: string,
    dto: UpdateTemplateDto,
    admin: Actor & { userId: string },
  ): Promise<TemplateView> {
    const existing = await this.repository.findTemplate(id);
    if (!existing) throw this.templateNotFound();
    this.assertPlaceholders(
      [dto.body ?? existing.body, dto.title ?? existing.title ?? ''],
      this.paramsFor(existing.eventCode),
    );
    const updated = await this.repository.transaction(async (tx) => {
      const template = await this.repository.updateTemplate(id, dto, tx);
      await this.audit.record(
        {
          action: 'notification_template.update',
          entityType: 'notification_template',
          entityId: id,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { fields: Object.keys(dto) },
        },
        tx,
      );
      return template;
    });
    return this.templateView(updated);
  }

  async listTemplates(query: TemplateListQuery): Promise<Page<TemplateView>> {
    const { items, total } = await this.repository.listTemplates(
      { eventCode: query.eventCode },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((t) => this.templateView(t)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async getTemplate(id: string): Promise<TemplateView> {
    const template = await this.repository.findTemplate(id);
    if (!template) throw this.templateNotFound();
    return this.templateView(template);
  }

  async listDeliveries(query: DeliveryListQuery): Promise<Page<DeliveryView>> {
    const { items, total } = await this.repository.list(
      { status: query.status, eventCode: query.eventCode, recipientUserId: query.recipientUserId },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((n) => ({
        id: n.id,
        eventCode: n.eventCode,
        channel: n.channel,
        status: n.status,
        recipientUserId: n.recipientUserId,
        attempts: n.attempts,
        lastError: n.lastError,
        sentAt: n.sentAt,
        createdAt: n.createdAt,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  private paramsFor(eventCode: string): readonly string[] {
    const params = EVENT_PARAMS[eventCode as NotificationEventCode];
    if (!params) {
      throw new DomainException(
        NotificationErrorCode.UNKNOWN_EVENT,
        'Unknown notification event',
        HttpStatus.BAD_REQUEST,
        [{ field: 'eventCode', messages: ['not a known event'] }],
      );
    }
    return params;
  }

  private assertPlaceholders(texts: string[], allowed: readonly string[]): void {
    const unknown = texts.flatMap(placeholdersOf).filter((p) => !allowed.includes(p));
    if (unknown.length > 0) {
      throw new DomainException(
        NotificationErrorCode.UNKNOWN_PLACEHOLDER,
        'The template uses placeholders this event does not provide',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'body',
            messages: [
              `allowed: ${allowed.join(', ')}`,
              `unknown: ${[...new Set(unknown)].join(', ')}`,
            ],
          },
        ],
      );
    }
  }

  private templateView(t: TemplateRecord): TemplateView {
    return {
      id: t.id,
      eventCode: t.eventCode,
      channel: t.channel,
      language: t.language,
      title: t.title,
      body: t.body,
      dltTemplateId: t.dltTemplateId,
      isActive: t.isActive,
      updatedAt: t.updatedAt,
    };
  }

  // --- in-app inbox (customer and worker apps) -------------------------------------------------------------

  async inbox(userId: string, query: InboxQuery): Promise<Page<InboxItemView>> {
    const { items, total } = await this.repository.listInbox(
      userId,
      { unreadOnly: query.unreadOnly === true },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((n) => ({
        id: n.id,
        event: n.eventCode,
        title: n.template?.title ? render(n.template.title, n.params) : null,
        body: n.template ? render(n.template.body, n.params) : '',
        route: routeFor(n.params),
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    return { unread: await this.repository.unreadCount(userId) };
  }

  /** Another user's notification answers exactly like an unknown one. */
  async markRead(userId: string, id: string): Promise<void> {
    if (!(await this.repository.markRead(userId, id))) {
      throw new DomainException(
        NotificationErrorCode.NOTIFICATION_NOT_FOUND,
        'Notification not found',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    return { updated: await this.repository.markAllRead(userId) };
  }

  /**
   * Delivery health for operators: counts per status, the age of the oldest waiting notification and of the oldest unprocessed
   * outbox event (a growing age means the worker process is down), and the queue depth. Aggregates only, no content.
   */
  async health(): Promise<HealthView> {
    const [byStatus, oldestQueuedSeconds, outbox, queue] = await Promise.all([
      this.repository.statusCounts(),
      this.repository.oldestQueuedAgeSeconds(),
      this.outbox.backlog(),
      this.queue
        .getJobCounts('waiting', 'active', 'delayed', 'failed')
        .then((c) => ({
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
        }))
        .catch(() => null),
    ]);
    return { notifications: { byStatus, oldestQueuedSeconds }, outbox, queue };
  }

  /** Manual recovery: a FAILED notification goes back to the queue. Any other status is refused, so nothing is sent twice. */
  async retryFailed(id: string, actor: Actor): Promise<void> {
    if (!(await this.repository.findById(id))) {
      throw new DomainException(
        NotificationErrorCode.NOTIFICATION_NOT_FOUND,
        'Notification not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const requeued = await this.repository.requeueFailed(id);
    if (!requeued) {
      throw new DomainException(
        NotificationErrorCode.NOTIFICATION_NOT_FAILED,
        'Only a FAILED notification can be retried',
        HttpStatus.CONFLICT,
      );
    }
    await this.audit.record({
      action: 'notification.retry',
      entityType: 'notification',
      entityId: id,
      actorId: actor.userId,
      actorRole: actor.roles.join(',') || null,
    });
    try {
      // A fresh job id: the original job (same id as the notification) is kept by the queue and would deduplicate this one.
      await this.queue.add(
        'deliver',
        { notificationId: id },
        { jobId: `${id}-retry-${requeued.attempts}` },
      );
    } catch {
      this.logger.warn(`Could not queue retry of ${id}; it stays QUEUED for the next sweep`);
    }
  }

  /** Manual recovery of a dead-lettered outbox event: it is dispatched again from scratch (notifications are de-duplicated). */
  async retryOutboxEvent(id: string, actor: Actor): Promise<void> {
    if (!(await this.outbox.retryDeadLettered(id))) {
      throw new DomainException(
        NotificationErrorCode.OUTBOX_EVENT_NOT_DEAD_LETTERED,
        'Only a dead-lettered outbox event can be retried',
        HttpStatus.CONFLICT,
      );
    }
    await this.audit.record({
      action: 'outbox.retry',
      entityType: 'outbox_event',
      entityId: id,
      actorId: actor.userId,
      actorRole: actor.roles.join(',') || null,
    });
  }

  private templateNotFound(): DomainException {
    return new DomainException(
      NotificationErrorCode.TEMPLATE_NOT_FOUND,
      'Template not found',
      HttpStatus.NOT_FOUND,
    );
  }
}
