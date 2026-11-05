import { randomUUID } from 'node:crypto';
import { assertIfMatch } from '../../common/concurrency/if-match';
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
  InvalidDeviceTokenError,
  PUSH_PROVIDER,
  SMS_PROVIDER,
  WHATSAPP_PROVIDER,
  EMAIL_PROVIDER,
  type EmailProvider,
  type PushProvider,
  type SmsProvider,
  type WhatsAppProvider,
} from '../../integrations/notifications/notification-providers.interface';
import { SessionService } from '../auth/session.service';
import type { Actor } from '../users/users.types';
import { UsersService } from '../users/users.service';
import { AppConfigService } from '../../config/app-config.service';
import { MessagingProviderKind } from '../../config/env.validation';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import {
  AdminTestPushDto,
  CreateTemplateDto,
  DeliveryListQuery,
  DeliveryView,
  EventView,
  InboxItemView,
  InboxQuery,
  NotificationAckDto,
  NotificationAckResponse,
  TemplateListQuery,
  TemplateView,
  TestPushDto,
  TestPushResponse,
  TestPushTokenResult,
  UnreadCountView,
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

/**
 * Events whose own entity has a screen of its own: the route points at that entity when the event really carries its id. Every
 * other event (and a missing id) falls back to the booking, then ticket, then the first id present.
 */
const ENTITY_ROUTES: Record<string, { param: string; type: string }> = {
  PAYMENT_SUCCEEDED: { param: 'paymentId', type: 'payment' },
  PAYMENT_FAILED: { param: 'paymentId', type: 'payment' },
  PAYMENT_UNDER_REVIEW: { param: 'paymentId', type: 'payment' },
  PAYMENT_REFUND_INITIATED: { param: 'paymentId', type: 'payment' },
  PAYMENT_REFUNDED: { param: 'paymentId', type: 'payment' },
  REPLACEMENT_UPDATE: { param: 'replacementId', type: 'replacement' },
  INTERVIEW_REQUESTED: { param: 'interviewId', type: 'interview' },
  INTERVIEW_RESPONDED: { param: 'interviewId', type: 'interview' },
  INTERVIEW_CANCELLED: { param: 'interviewId', type: 'interview' },
};

/** Where a tap on an inbox item or a push should lead, from the event and the ids in its parameters (deep link). */
export function routeFor(
  params: Record<string, string>,
  event?: string,
): { type: string; id: string } | null {
  const own = event ? ENTITY_ROUTES[event] : undefined;
  if (own && params[own.param]) return { type: own.type, id: params[own.param] };
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
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly config: AppConfigService,
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
      if (providerMessageId === null) {
        // Every bound device token was rejected as dead (and has been removed): nothing can receive it.
        await this.repository.finish(notification.id, {
          status: 'SKIPPED',
          lastError: 'NO_VALID_DEVICE',
        });
        return 'SKIPPED';
      }
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

  private async resolveTarget(notification: NotificationRecord): Promise<
    | { kind: 'skip'; reason: string }
    | {
        kind: 'send';
        text: string;
        title: string;
        mobile: string | null;
        tokens: string[];
        email?: string;
      }
  > {
    const [user, template] = await Promise.all([
      this.users.findById(notification.recipientUserId),
      this.repository.findTemplateById(notification.templateId),
    ]);
    if (!user || user.status !== 'ACTIVE') return { kind: 'skip', reason: 'RECIPIENT_INACTIVE' };
    if (!template || !template.isActive) return { kind: 'skip', reason: 'TEMPLATE_INACTIVE' };
    const text = render(template.body, notification.params);
    const title = render(template.title ?? '', notification.params);
    if (notification.channel === 'EMAIL') {
      // DEC-17: only to an address on file and only for users who did not opt out.
      const target = await this.repository.emailTarget(user.id);
      if (!target?.address) return { kind: 'skip', reason: 'NO_EMAIL' };
      if (!target.optedIn) return { kind: 'skip', reason: 'EMAIL_OPT_OUT' };
      return { kind: 'send', text, title, mobile: null, tokens: [], email: target.address };
    }
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
    target: {
      text: string;
      title: string;
      mobile: string | null;
      tokens: string[];
      email?: string;
    },
  ): Promise<string | null> {
    switch (notification.channel) {
      case 'EMAIL':
        return (
          await this.email.sendEmail({
            to: target.email!,
            subject: target.title,
            body: target.text,
            idempotencyKey: notification.id,
          })
        ).providerMessageId;
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
      default:
        return this.sendPush(notification, target);
    }
  }

  /**
   * FCM data payload (all values strings, ids only): notificationId, event, and - when the event names an entity - routeType and
   * routeId (the same pair as `route` in the inbox). One failing device never blocks the others: a token the provider reports as
   * dead is removed and skipped; any other failure is kept and, if no device at all was reached, rethrown so the queue retries or
   * the notification fails. Returns null when every token was dead.
   */
  private async sendPush(
    notification: NotificationRecord,
    target: { text: string; title: string; tokens: string[] },
  ): Promise<string | null> {
    const route = routeFor(notification.params, notification.eventCode);
    const data: Record<string, string> = {
      notificationId: notification.id,
      event: notification.eventCode,
      ...(route ? { routeType: route.type, routeId: route.id } : {}),
    };
    let delivered: string | null = null;
    let failure: Error | null = null;
    for (const deviceToken of target.tokens) {
      try {
        delivered = (
          await this.push.sendPush({ deviceToken, title: target.title, body: target.text, data })
        ).providerMessageId;
      } catch (error) {
        if (error instanceof InvalidDeviceTokenError) {
          await this.sessions.removeDeviceToken(deviceToken);
        } else {
          failure ??= error instanceof Error ? error : new Error('push delivery failed');
        }
      }
    }
    if (delivered === null && failure) throw failure;
    return delivered;
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
    ifMatch?: string,
  ): Promise<TemplateView> {
    const existing = await this.repository.findTemplate(id);
    if (!existing) throw this.templateNotFound();
    assertIfMatch(ifMatch, existing.updatedAt);
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
        route: routeFor(n.params, n.eventCode),
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async unreadCount(userId: string): Promise<UnreadCountView> {
    const count = await this.repository.unreadCount(userId);
    return { count, unread: count };
  }

  /** Puts one of my own inbox items back to unread. Another user's notification answers like an unknown one. Repeating is harmless. */
  async markUnread(userId: string, id: string): Promise<void> {
    if (!(await this.repository.markUnread(userId, id))) {
      throw new DomainException(
        NotificationErrorCode.NOTIFICATION_NOT_FOUND,
        'Notification not found',
        HttpStatus.NOT_FOUND,
      );
    }
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
   * Mobile device push acknowledgement telemetry (D-104).
   * Validates notification ownership, sets readAt if TAPPED, and logs telemetry audit record. Idempotent.
   */
  async acknowledge(
    userId: string,
    notificationId: string,
    dto: NotificationAckDto,
  ): Promise<NotificationAckResponse> {
    const notification = await this.repository.findById(notificationId);
    if (!notification || notification.recipientUserId !== userId) {
      throw new DomainException(
        NotificationErrorCode.NOTIFICATION_NOT_FOUND,
        'Notification not found',
        HttpStatus.NOT_FOUND,
      );
    }

    if (dto.eventType === 'TAPPED') {
      await this.repository.markRead(userId, notificationId);
    }

    await this.audit.record({
      action: 'notification.acknowledged',
      entityType: 'notification',
      entityId: notificationId,
      actorId: userId,
      actorRole: 'USER',
      metadata: {
        eventType: dto.eventType,
        channel: notification.channel,
        eventCode: notification.eventCode,
        deviceTimestamp: dto.deviceTimestamp ?? null,
      },
    });

    return {
      acknowledged: true,
      eventType: dto.eventType,
      notificationId,
    };
  }

  /**
   * Diagnostic test push notification dispatch for Worker / Customer App diagnostics (D-104).
   * Restricts production dispatch to administrators unless ALLOW_TEST_PUSH=true.
   * Resolves registered device tokens for the authenticated user and dispatches test push via active PushProvider.
   */
  async testPush(user: AuthenticatedUser, dto?: TestPushDto): Promise<TestPushResponse> {
    if (this.config.isProduction && !this.config.allowTestPush && user.type !== 'ADMIN') {
      throw new DomainException(
        'TEST_PUSH_RESTRICTED',
        'Test push notification endpoint is restricted to staging/development environments or administrator accounts',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.dispatchTestPush(user.userId, user, dto);
  }

  /**
   * Administrator variant (D-104): sends to an explicit customer's or worker's registered device(s) from the admin-only
   * endpoint. The caller's own devices are never used, and the target user id is written to the audit record.
   */
  adminTestPush(admin: AuthenticatedUser, dto: AdminTestPushDto): Promise<TestPushResponse> {
    return this.dispatchTestPush(dto.userId, admin, dto);
  }

  private async dispatchTestPush(
    targetUserId: string,
    actor: AuthenticatedUser,
    dto?: TestPushDto,
  ): Promise<TestPushResponse> {
    const correlationId = dto?.correlationId?.trim() || randomUUID();
    const tokens = await this.sessions.listDeviceTokens(targetUserId);
    const title = dto?.title?.trim() || 'SevaNest Test Notification';
    const body = dto?.body?.trim() || 'Your push notification setup is working successfully!';
    const providerKind = this.config.pushProvider;
    const projectId = this.config.firebaseProjectId;

    if (tokens.length === 0) {
      return {
        success: false,
        correlationId,
        diagnostic_id: correlationId,
        firebase_initialized: providerKind === MessagingProviderKind.Fcm,
        registration_found: false,
        active_token_count: 0,
        dispatch_attempted: false,
        firebase_accepted_count: 0,
        firebase_failure_count: 0,
        result: 'NO_ACTIVE_DEVICE_TOKEN',
        stage: 'NO_DEVICE_TOKEN',
        message:
          'No active FCM device token found for this user. The mobile app must register an FCM token via PUT /api/v1/auth/device-token first.',
        pushProvider: providerKind,
        firebaseProjectId: projectId,
        tokensCount: 0,
        tokens: [],
        diagnostics: {
          tokenRegistered: false,
          fcmConfigured: providerKind === MessagingProviderKind.Fcm,
          deliveredCount: 0,
          failedCount: 0,
          foregroundHandlingNote:
            'Notification cannot be received until device registers its FCM token with backend.',
          backgroundHandlingNote:
            'Notification cannot be received until device registers its FCM token with backend.',
          troubleshootingRecommendation:
            'ISSUE IS IN APP: The Flutter app has not registered an FCM token with the backend. Call FirebaseMessaging.instance.getToken() and submit it to PUT /api/v1/auth/device-token.',
        },
        dispatchedAt: new Date(),
      };
    }

    if (providerKind === MessagingProviderKind.Disabled) {
      return {
        success: false,
        correlationId,
        diagnostic_id: correlationId,
        firebase_initialized: false,
        registration_found: true,
        active_token_count: tokens.length,
        dispatch_attempted: false,
        firebase_accepted_count: 0,
        firebase_failure_count: tokens.length,
        result: 'FIREBASE_NOT_INITIALIZED',
        stage: 'CONFIG_ERROR',
        message:
          'PUSH_PROVIDER is disabled on this backend instance. Set PUSH_PROVIDER=fcm and configure Firebase service account credentials.',
        pushProvider: providerKind,
        firebaseProjectId: projectId,
        tokensCount: tokens.length,
        tokens: tokens.map((t) => ({
          token: this.maskToken(t),
          status: 'FAILED',
          error: 'PUSH_PROVIDER_DISABLED',
        })),
        diagnostics: {
          tokenRegistered: true,
          fcmConfigured: false,
          deliveredCount: 0,
          failedCount: tokens.length,
          foregroundHandlingNote: 'Backend push provider is disabled.',
          backgroundHandlingNote: 'Backend push provider is disabled.',
          troubleshootingRecommendation:
            'ISSUE IS IN BACKEND: PUSH_PROVIDER is set to disabled or Firebase credentials (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) are missing in environment.',
        },
        dispatchedAt: new Date(),
      };
    }

    const testId = randomUUID();
    const data: Record<string, string> = {
      type: 'TEST_PUSH',
      event: 'TEST_PUSH',
      notificationId: testId,
      title,
      body,
      routeType: 'test',
      routeId: testId,
      channelId: 'sevanest_high_importance',
      priority: 'high',
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    };

    const results: TestPushTokenResult[] = [];
    let deliveredCount = 0;
    let failedCount = 0;

    for (const deviceToken of tokens) {
      const masked = this.maskToken(deviceToken);
      try {
        const res = await this.push.sendPush({ deviceToken, title, body, data });
        deliveredCount += 1;
        results.push({
          token: masked,
          status: 'DELIVERED',
          providerMessageId: res.providerMessageId,
        });
      } catch (error) {
        failedCount += 1;
        this.logTestPushFailure(error, masked, correlationId);
        if (error instanceof InvalidDeviceTokenError) {
          await this.sessions.removeDeviceToken(deviceToken).catch(() => undefined);
          results.push({
            token: masked,
            status: 'FAILED',
            error:
              'INVALID_REGISTRATION_TOKEN: Token is dead or unregistered on Firebase. Cleaned up from database.',
          });
        } else {
          results.push({
            token: masked,
            status: 'FAILED',
            error: this.testPushErrorCode(error),
          });
        }
      }
    }

    await this.audit.record({
      action: 'notification.test_push',
      entityType: 'notification_test',
      entityId: testId,
      actorId: actor.userId,
      actorRole: actor.type,
      metadata: {
        correlationId,
        targetUserId,
        targetIsActor: targetUserId === actor.userId,
        tokensFound: tokens.length,
        deliveredCount,
        failedCount,
        provider: providerKind,
      },
    });

    const isSuccessful = deliveredCount > 0;
    const resultOutcome = isSuccessful
      ? 'FCM_ACCEPTED'
      : results.some((r) => r.error?.includes('INVALID_REGISTRATION_TOKEN'))
        ? 'INVALID_FCM_TOKEN'
        : 'FCM_DISPATCH_FAILED';
    return {
      success: isSuccessful,
      correlationId,
      diagnostic_id: correlationId,
      firebase_initialized: true,
      registration_found: true,
      active_token_count: tokens.length,
      dispatch_attempted: true,
      firebase_accepted_count: deliveredCount,
      firebase_failure_count: failedCount,
      result: resultOutcome,
      stage: isSuccessful ? 'DISPATCHED' : 'FAILED',
      message: isSuccessful
        ? `Test push notification dispatched successfully to ${deliveredCount} device(s).`
        : `Failed to dispatch test push notification to any registered device.`,
      pushProvider: providerKind,
      firebaseProjectId: projectId,
      tokensCount: tokens.length,
      tokens: results,
      diagnostics: {
        tokenRegistered: true,
        fcmConfigured: true,
        deliveredCount,
        failedCount,
        foregroundHandlingNote:
          "In Flutter foreground state, FirebaseMessaging.onMessage receives this payload. Ensure you display a local notification using flutter_local_notifications on AndroidNotificationChannel('sevanest_high_importance', 'High Importance', importance: Importance.max).",
        backgroundHandlingNote:
          'In background or terminated mode, the FCM notification banner will pop up automatically in the Android notification drawer with title and body.',
        ...(failedCount > 0 && failedCount === tokens.length
          ? {
              troubleshootingRecommendation: results.some((r) => r.error === 'SENDER_ID_MISMATCH')
                ? 'SENDER_ID_MISMATCH: The device token belongs to a different Firebase project. Verify that google-services.json in mobile app matches backend Firebase Project ID "' +
                  projectId +
                  '". Quote correlationId ' +
                  correlationId +
                  ' when reporting this.'
                : 'FCM API rejected dispatch. Verify that google-services.json in mobile app matches Firebase Project ID "' +
                  projectId +
                  '" and backend FCM credentials are valid. Quote correlationId ' +
                  correlationId +
                  ' when reporting this.',
            }
          : {}),
      },
      dispatchedAt: new Date(),
    };
  }

  private logTestPushFailure(error: unknown, maskedToken: string, correlationId: string): void {
    const providerError = error instanceof ProviderError ? error : null;
    const cause = providerError?.cause as
      | {
          status?: number;
          json?: {
            error?: {
              code?: number;
              message?: string;
              status?: string;
              details?: Array<{ errorCode?: string; '@type'?: string }>;
            };
          };
        }
      | undefined;
    const googleError = cause?.json?.error;
    const details = Array.isArray(googleError?.details)
      ? googleError.details
          .map((d) => d?.errorCode || d?.['@type'] || '')
          .filter(Boolean)
          .join(', ')
      : '';
    this.logger.warn(
      `[TestPush] Push delivery failed for token ${maskedToken}: ` +
        `status=${cause?.status ?? 'unknown'}, ` +
        `code=${googleError?.status ?? googleError?.code ?? 'unknown'}, ` +
        `details=${details || googleError?.message || (error instanceof Error ? error.message : 'Unknown error')}, ` +
        `correlationId=${correlationId}`,
    );
  }

  /** A stable reason code for the diagnostic response; never provider text, a token or a key. */
  private testPushErrorCode(error: unknown): string {
    if (error instanceof InvalidDeviceTokenError) return 'INVALID_REGISTRATION_TOKEN';
    if (error instanceof ProviderError) {
      const cause = error.cause as
        | {
            status?: number;
            json?: {
              error?: {
                status?: string;
                message?: string;
                details?: Array<{ errorCode?: string }>;
              };
            };
          }
        | undefined;
      const body = cause?.json;
      const fcmCode = body?.error?.details?.find((d) => d?.errorCode)?.errorCode;
      if (
        fcmCode === 'SENDER_ID_MISMATCH' ||
        /sender.*mismatch/i.test(body?.error?.message ?? '')
      ) {
        return 'SENDER_ID_MISMATCH';
      }
      return error.retryable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED';
    }
    return 'DISPATCH_FAILED';
  }

  private maskToken(token: string): string {
    if (token.length <= 12) return '***';
    return `${token.slice(0, 6)}...${token.slice(-6)}`;
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
