import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { AlertListQuery, AlertView, ResolveAlertDto } from './alerts.dto';
import { AlertsService, type AlertSeverity, type StaffActor } from './alerts.service';

/** The staff alert inbox: stuck bookings, SLA breaches, money problems. Each alert is visible only to admins who hold its permission. */
@ApiTags('Admin - Alerts')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/alerts', version: '1' })
export class AdminAlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @Permissions(PermissionCode.ALERT_VIEW)
  @ApiOperation({
    summary: 'Open alerts (newest first, paginated); filter by status, severity, type',
  })
  async list(
    @Query() query: AlertListQuery,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<Page<AlertView>> {
    return this.alerts.list(query, await this.actor(admin));
  }

  @Get('summary')
  @Permissions(PermissionCode.ALERT_VIEW)
  @ApiOperation({ summary: 'Open alert counts by severity (for the dashboard badge)' })
  async summary(
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<{ open: number; bySeverity: Record<AlertSeverity, number> }> {
    return this.alerts.summary(await this.actor(admin));
  }

  @Post(':alertId/acknowledge')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.ALERT_MANAGE)
  @ApiOperation({ summary: 'Mark that someone is looking at it (repeating is harmless; audited)' })
  async acknowledge(
    @Param('alertId', ParseUUIDPipe) alertId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AlertView> {
    return this.alerts.acknowledge(alertId, await this.actor(admin));
  }

  @Post(':alertId/resolve')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.ALERT_MANAGE)
  @ApiOperation({
    summary: 'Close an alert with a note (audited)',
    description:
      'Resolving does not change the booking, ticket or payment the alert is about. If the problem is detected again the alert re-opens.',
  })
  async resolve(
    @Param('alertId', ParseUUIDPipe) alertId: string,
    @Body() dto: ResolveAlertDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AlertView> {
    return this.alerts.resolve(alertId, dto.note, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<StaffActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
