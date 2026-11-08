import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { PageQueryDto } from '../../common/pagination/pagination';
import type { Page } from '../../common/pagination/pagination';
import { MatchCandidatesResponse } from '../matching/dto/matching.dto';
import { WorkerCard } from '../search/dto/search.dto';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminReplacementListQuery,
  AdminReplacementView,
  CreateReplacementDto,
  DecisionDto,
  ReplacementDetailView,
  ReplacementListQuery,
  ReplacementReasonAdminView,
  ReplacementView,
  SelectReplacementWorkerDto,
  UpdateReplacementReasonDto,
} from './dto/replacement.dto';
import { ReplacementActor, ReplacementService } from './replacement.service';

/** A customer's own replacement requests (FRD FM-06 "replace", FM-11). Every lookup is scoped to the signed-in customer. */
@ApiTags('Replacements')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'replacement-requests', version: '1' })
export class ReplacementsController {
  constructor(private readonly replacements: ReplacementService) {}

  @Idempotent()
  @Post()
  @ApiModelResponse(ReplacementView, { status: 201 })
  @ApiOperation({
    summary: 'Ask for a replacement of my active booking',
    description:
      'Customer bearer token (CUSTOMER only). The booking moves to REPLACEMENT_REQUESTED. 404 for a booking that is not mine, 422 REPLACEMENT_NOT_ELIGIBLE, 409 while a request is already open.',
  })
  create(
    @Body() dto: CreateReplacementDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplacementView> {
    return this.replacements.request(user.userId, dto);
  }

  @Get()
  @ApiPageResponse(ReplacementView)
  @ApiOperation({
    summary: 'My replacement requests, newest first (paginated)',
    description: 'Customer bearer token (CUSTOMER only). Returns only requests made by the caller.',
  })
  list(
    @Query() query: ReplacementListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<ReplacementView>> {
    return this.replacements.listMine(user.userId, query);
  }

  @Get(':requestId')
  @ApiModelResponse(ReplacementDetailView)
  @ApiOperation({
    summary: 'One of my requests with its status timeline (404 for anyone else)',
    description:
      'Customer bearer token (CUSTOMER only). `decisionMessage` is the customer-facing message; internal staff remarks are never returned. `timeline` is the persisted status history, oldest first.',
  })
  get(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplacementDetailView> {
    return this.replacements.getMine(user.userId, requestId);
  }

  @Get(':requestId/alternatives')
  @ApiPageResponse(WorkerCard)
  @ApiOperation({
    summary: 'Workers I can choose from once the request is APPROVED',
    description:
      'Customer bearer token (CUSTOMER only). Same eligibility as selection, never the worker being replaced. 409 INVALID_TRANSITION unless the request is APPROVED; 404 for anyone else. Selection checks again, so a listed worker can still be refused with WORKER_NOT_ELIGIBLE (422) or WORKER_UNAVAILABLE (409).',
  })
  alternatives(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Query() query: PageQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<WorkerCard>> {
    return this.replacements.alternatives(user.userId, requestId, query.page, query.limit);
  }

  @Idempotent()
  @Post(':requestId/cancel')
  @ApiModelResponse(ReplacementView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw an open request; the booking becomes ACTIVE again',
    description: 'Customer bearer token (CUSTOMER only). The caller must own the request.',
  })
  cancel(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplacementView> {
    return this.replacements.cancel(user.userId, requestId);
  }

  @Idempotent()
  @Post(':requestId/select')
  @ApiModelResponse(ReplacementView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Choose the replacement worker once the request is approved',
    description:
      'Customer bearer token (CUSTOMER only). Creates the replacement booking (MATCHED, to continue through the normal lifecycle) and closes the old booking as REPLACED. The worker must be eligible and different from the current one. Repeating with the same worker changes nothing.',
  })
  select(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: SelectReplacementWorkerDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplacementView> {
    return this.replacements.select(requestId, dto.workerId, {
      kind: 'CUSTOMER',
      userId: user.userId,
    });
  }
}

/** Support/Admin review of replacement requests (FR-REP-003) and assisted selection (FR-WD-007). */
@ApiTags('Admin - Replacements')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/replacement-requests', version: '1' })
export class AdminReplacementsController {
  constructor(
    private readonly replacements: ReplacementService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiPageResponse(AdminReplacementView)
  @Permissions(PermissionCode.REPLACEMENT_VIEW)
  @ApiOperation({
    summary: 'All replacement requests (paginated, filter by status/booking)',
    description: 'Admin bearer token (ADMIN only); requires replacement.view.',
  })
  list(@Query() query: AdminReplacementListQuery): Promise<Page<AdminReplacementView>> {
    return this.replacements.adminList(query);
  }

  @Get(':requestId')
  @ApiModelResponse(AdminReplacementView)
  @Permissions(PermissionCode.REPLACEMENT_VIEW)
  @ApiOperation({
    summary: 'One request with who asked, who decided and the worker being replaced',
    description: 'Admin bearer token (ADMIN only); requires replacement.view.',
  })
  get(@Param('requestId', ParseUUIDPipe) requestId: string): Promise<AdminReplacementView> {
    return this.replacements.adminGet(requestId);
  }

  @Post(':requestId/approve')
  @ApiModelResponse(AdminReplacementView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({
    summary: 'Approve eligibility (REQUESTED to APPROVED)',
    description: 'Admin bearer token (ADMIN only); requires replacement.manage.',
  })
  async approve(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecisionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminReplacementView> {
    return this.replacements.approve(requestId, dto.remarks, dto.message, await this.actor(admin));
  }

  @Post(':requestId/reject')
  @ApiModelResponse(AdminReplacementView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({
    summary: 'Reject a request (remarks required); the booking becomes ACTIVE again',
    description: 'Admin bearer token (ADMIN only); requires replacement.manage.',
  })
  async reject(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecisionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminReplacementView> {
    return this.replacements.reject(
      requestId,
      dto.remarks ?? '',
      dto.message,
      await this.actor(admin),
    );
  }

  @Get(':requestId/candidates')
  @ApiModelResponse(MatchCandidatesResponse)
  @Permissions(PermissionCode.REPLACEMENT_VIEW, PermissionCode.MATCHING_RUN)
  @ApiOperation({
    summary:
      'Alternative workers for the booking requirement (excludes the current worker; audited)',
    description: 'Admin bearer token (ADMIN only); requires replacement.view and matching.run.',
  })
  async candidates(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Query() query: PageQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<MatchCandidatesResponse> {
    return this.replacements.candidates(
      requestId,
      await this.actor(admin),
      query.page,
      query.limit,
    );
  }

  @Post(':requestId/select')
  @Idempotent()
  @ApiModelResponse(ReplacementView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({
    summary: 'Select the replacement worker on the customer behalf (audited)',
    description: 'Admin bearer token (ADMIN only); requires replacement.manage.',
  })
  async select(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: SelectReplacementWorkerDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ReplacementView> {
    return this.replacements.select(requestId, dto.workerId, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<ReplacementActor & { roles: string[] }> {
    const access = await this.users.getAccess(admin.userId);
    return { kind: 'ADMIN', userId: admin.userId, roles: access.roles };
  }
}

/** Admin management for the fixed replacement reason catalogue. Codes are never created or deleted. */
@ApiTags('Admin - Replacements')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/replacement-reasons', version: '1' })
export class AdminReplacementReasonsController {
  constructor(
    private readonly replacements: ReplacementService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiModelResponse(ReplacementReasonAdminView, { isArray: true })
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({
    summary: 'List all fixed replacement reasons, including disabled codes',
    description: 'Admin bearer token (ADMIN only); requires replacement.manage.',
  })
  list(): Promise<ReplacementReasonAdminView[]> {
    return this.replacements.adminReasons();
  }

  @Patch(':code')
  @Idempotent()
  @ApiModelResponse(ReplacementReasonAdminView)
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({
    summary: 'Change a predefined reason label or enablement (audited)',
    description:
      'Only the six stable reason codes can be changed. Disabled reasons are omitted from public reference data and rejected for new requests.',
  })
  async update(
    @Param('code') code: string,
    @Body() dto: UpdateReplacementReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ReplacementReasonAdminView> {
    const access = await this.users.getAccess(admin.userId);
    return this.replacements.updateReason(code, dto, {
      kind: 'ADMIN',
      userId: admin.userId,
      roles: access.roles,
    });
  }
}
