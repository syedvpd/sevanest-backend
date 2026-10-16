import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import type { Response } from 'express';
import { etagOf } from '../../common/concurrency/if-match';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
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
  UnreadCountView,
  UpdateTemplateDto,
} from './dto/notifications.dto';
import { HealthView, NotificationsService } from './notifications.service';
import { RequireIfMatch } from '../../common/concurrency/if-match.guard';

/** Admin-configurable wording and channels per event (FR-NOT-004) and the delivery log (FR-NOT-005). */
@ApiTags('Admin - Notifications')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin', version: '1' })
export class AdminNotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
  ) {}

  @Get('notification-events')
  @ApiPageResponse(TemplateView)
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'The events that can notify, with the placeholders a template may use' })
  events(): EventView[] {
    return this.notifications.events();
  }

  @Get('notification-templates')
  @ApiPageResponse(TemplateView)
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Templates (paginated)' })
  list(@Query() query: TemplateListQuery): Promise<Page<TemplateView>> {
    return this.notifications.listTemplates(query);
  }

  @Get('notification-templates/:templateId')
  @ApiModelResponse(TemplateView)
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'One template (ETag for If-Match)' })
  async get(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TemplateView> {
    const template = await this.notifications.getTemplate(templateId);
    res.setHeader('ETag', etagOf(template.updatedAt));
    return template;
  }

  @Post('notification-templates')
  @ApiModelResponse(TemplateView, { status: 201 })
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Create a template (wording + channel for an event)',
    description:
      'An event notifies only through channels that have an active template. Placeholders must be ones the event provides (400 UNKNOWN_PLACEHOLDER). 409 TEMPLATE_EXISTS.',
  })
  async create(
    @Body() dto: CreateTemplateDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<TemplateView> {
    return this.notifications.createTemplate(dto, await this.actor(admin));
  }

  @Patch('notification-templates/:templateId')
  @RequireIfMatch()
  @ApiModelResponse(TemplateView)
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Change wording or switch a template on or off' })
  async update(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<TemplateView> {
    return this.notifications.updateTemplate(templateId, dto, await this.actor(admin), ifMatch);
  }

  @Get('notifications')
  @ApiPageResponse(DeliveryView)
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Delivery log, newest first (paginated)',
    description:
      'Channel, event, status and attempts. No message text, phone number, token or provider detail.',
  })
  deliveries(@Query() query: DeliveryListQuery): Promise<Page<DeliveryView>> {
    return this.notifications.listDeliveries(query);
  }

  @Get('notifications/health')
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Delivery and outbox health',
    description:
      'Counts per status, age of the oldest waiting notification and unprocessed outbox event, queue depth (null if Redis is down). Aggregates only.',
  })
  health(): Promise<HealthView> {
    return this.notifications.health();
  }

  @Post('notifications/:notificationId/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Retry a FAILED notification',
    description:
      '404 NOTIFICATION_NOT_FOUND; 409 NOTIFICATION_NOT_FAILED for any other status. Audited.',
  })
  async retry(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<void> {
    await this.notifications.retryFailed(notificationId, await this.actor(admin));
  }

  @Post('outbox-events/:eventId/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Retry a dead-lettered outbox event',
    description:
      'Events that failed to dispatch five times stop being retried (see health.outbox.deadLettered). 409 OUTBOX_EVENT_NOT_DEAD_LETTERED otherwise. Audited.',
  })
  async retryOutbox(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<void> {
    await this.notifications.retryOutboxEvent(eventId, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<{ userId: string; roles: string[] }> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}

/** The signed-in customer's or worker's in-app inbox (their own messages only). */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class InboxController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiPageResponse(InboxItemView)
  @ApiOperation({
    summary: 'My in-app notifications, newest first',
    description:
      'Each item has a deep-link `route` ({type, id}). Only messages for channels that have an active IN_APP template exist.',
  })
  list(
    @Query() query: InboxQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<InboxItemView>> {
    return this.notifications.inbox(user.userId, query);
  }

  @Get('unread-count')
  @ApiModelResponse(UnreadCountView)
  @ApiOperation({
    summary: 'Number of unread in-app notifications (for the badge)',
    description: 'Returns `{count, unread}` (identical values; `unread` is the older name).',
  })
  unread(@CurrentUser() user: AuthenticatedUser): Promise<UnreadCountView> {
    return this.notifications.unreadCount(user.userId);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all my notifications read (repeating is harmless)' })
  readAll(@CurrentUser() user: AuthenticatedUser): Promise<{ updated: number }> {
    return this.notifications.markAllRead(user.userId);
  }

  @Post(':notificationId/unread')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark one of my notifications unread again',
    description:
      "404 for an unknown id and for someone else's notification. Repeating is harmless.",
  })
  async unreadOne(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.notifications.markUnread(user.userId, notificationId);
  }

  @Post(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark one of my notifications read',
    description: "404 for an unknown id and for someone else's notification.",
  })
  async read(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.notifications.markRead(user.userId, notificationId);
  }
}
