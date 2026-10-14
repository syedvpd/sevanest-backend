import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminBlockView,
  AdminCreateBlockDto,
  AdminListQuery,
  AdminReportView,
  BlockView,
  CreateBlockDto,
  CreateReportDto,
  ReportView,
} from './safety.dto';
import { SafetyActor, SafetyService, StaffActor } from './safety.service';

/** Report and block for customers and workers (PRD 9.1). Every target is checked against a real relationship of the caller. */
@ApiTags('Safety')
@ApiBearerAuth()
@RequireUserType('CUSTOMER', 'WORKER')
@Controller({ path: 'safety', version: '1' })
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Idempotent()
  @Post('blocks')
  @ApiModelResponse(BlockView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Block a worker (customers) or the customer of a booking (workers)',
    description:
      'Blocked pairs never see each other in search, shortlist, matching or replacement candidates and cannot be booked together. Repeating is harmless. 404 for anyone you have no relationship with.',
  })
  block(@Body() dto: CreateBlockDto, @CurrentUser() user: AuthenticatedUser): Promise<BlockView> {
    return this.safety.block(this.actor(user), dto);
  }

  @Get('blocks')
  @ApiModelResponse(BlockView, { isArray: true })
  @ApiOperation({ summary: 'The blocks I made' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<BlockView[]> {
    return this.safety.listMine(this.actor(user));
  }

  @Delete('blocks/:blockId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Lift a block I made',
    description: "404 for anyone else's block; 409 BLOCK_ADMIN_APPLIED when our team applied it.",
  })
  async unblock(
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.safety.unblock(this.actor(user), blockId);
  }

  @Idempotent()
  @Post('reports')
  @ApiModelResponse(ReportView, { status: 201 })
  @ApiOperation({
    summary: 'Report a worker or customer (safety, misconduct, fraud ...)',
    description:
      'Staff are alerted. `alsoBlock: true` blocks them as well. Send `Idempotency-Key` so a retry returns the first report (header `Idempotent-Replay: true`) instead of filing a second one. `reasonCode` is the machine-readable reason; `note` (max 1000) is the free-text account for staff; `reason` (max 500) is only the text kept with the block when `alsoBlock` is true (the reason code is kept if it is absent). The response `id` is the report id; no support ticket is created or linked. Customers name the worker with `workerId` and/or `bookingId`; if both are sent the worker must be the one on that booking, otherwise 404 SAFETY_TARGET_NOT_FOUND. Lateness, leaving early, wrong attendance and work quality are not safety reports: use a support ticket or the attendance flow.',
  })
  report(
    @Body() dto: CreateReportDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReportView> {
    return this.safety.report(this.actor(user), dto);
  }

  private actor(user: AuthenticatedUser): SafetyActor {
    return { userId: user.userId, kind: user.type === 'WORKER' ? 'WORKER' : 'CUSTOMER' };
  }
}

/** Staff side: reports and blocks. */
@ApiTags('Admin - Safety')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/safety', version: '1' })
export class AdminSafetyController {
  constructor(
    private readonly safety: SafetyService,
    private readonly users: UsersService,
  ) {}

  @Get('reports')
  @ApiPageResponse(AdminReportView)
  @Permissions(PermissionCode.SUPPORT_VIEW)
  @ApiOperation({ summary: 'Safety reports, newest first (filter by a user on either side)' })
  reports(@Query() query: AdminListQuery): Promise<Page<AdminReportView>> {
    return this.safety.adminListReports(query);
  }

  @Get('blocks')
  @ApiPageResponse(AdminBlockView)
  @Permissions(PermissionCode.SUPPORT_VIEW)
  @ApiOperation({ summary: 'Blocks (filter by a user on either side)' })
  blocks(@Query() query: AdminListQuery): Promise<Page<AdminBlockView>> {
    return this.safety.adminListBlocks(query);
  }

  @Post('blocks')
  @ApiModelResponse(AdminBlockView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.SUPPORT_MANAGE)
  @ApiOperation({
    summary: 'Apply a block between two customer/worker accounts (reason required, audited)',
    description: 'The user cannot lift a block applied by staff.',
  })
  async block(
    @Body() dto: AdminCreateBlockDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminBlockView> {
    return this.safety.adminBlock(dto, await this.actor(admin));
  }

  @Delete('blocks/:blockId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions(PermissionCode.SUPPORT_MANAGE)
  @ApiOperation({ summary: 'Lift any block (audited)' })
  async unblock(
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<void> {
    await this.safety.adminUnblock(blockId, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<StaffActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
