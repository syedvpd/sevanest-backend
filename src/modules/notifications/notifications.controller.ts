import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
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
  TemplateListQuery,
  TemplateView,
  UpdateTemplateDto,
} from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

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
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'The events that can notify, with the placeholders a template may use' })
  events(): EventView[] {
    return this.notifications.events();
  }

  @Get('notification-templates')
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Templates (paginated)' })
  list(@Query() query: TemplateListQuery): Promise<Page<TemplateView>> {
    return this.notifications.listTemplates(query);
  }

  @Get('notification-templates/:templateId')
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'One template' })
  get(@Param('templateId', ParseUUIDPipe) templateId: string): Promise<TemplateView> {
    return this.notifications.getTemplate(templateId);
  }

  @Post('notification-templates')
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
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({ summary: 'Change wording or switch a template on or off' })
  async update(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<TemplateView> {
    return this.notifications.updateTemplate(templateId, dto, await this.actor(admin));
  }

  @Get('notifications')
  @Permissions(PermissionCode.NOTIFICATION_MANAGE)
  @ApiOperation({
    summary: 'Delivery log, newest first (paginated)',
    description:
      'Channel, event, status and attempts. No message text, phone number, token or provider detail.',
  })
  deliveries(@Query() query: DeliveryListQuery): Promise<Page<DeliveryView>> {
    return this.notifications.listDeliveries(query);
  }

  private async actor(admin: AuthenticatedUser): Promise<{ userId: string; roles: string[] }> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
