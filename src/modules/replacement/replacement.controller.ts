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
import { PageQueryDto } from '../../common/pagination/pagination';
import type { Page } from '../../common/pagination/pagination';
import { MatchCandidatesResponse } from '../matching/dto/matching.dto';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminReplacementListQuery,
  AdminReplacementView,
  CreateReplacementDto,
  DecisionDto,
  ReplacementListQuery,
  ReplacementView,
  SelectReplacementWorkerDto,
} from './dto/replacement.dto';
import { ReplacementActor, ReplacementService } from './replacement.service';

/** A customer's own replacement requests (FRD FM-06 "replace", FM-11). Every lookup is scoped to the signed-in customer. */
@ApiTags('Replacements')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'replacement-requests', version: '1' })
export class ReplacementsController {
  constructor(private readonly replacements: ReplacementService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask for a replacement of my active booking',
    description:
      'The booking moves to REPLACEMENT_REQUESTED. 404 for a booking that is not mine, 422 REPLACEMENT_NOT_ELIGIBLE, 409 while a request is already open.',
  })
  create(
    @Body() dto: CreateReplacementDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplacementView> {
    return this.replacements.request(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'My replacement requests, newest first (paginated)' })
  list(
    @Query() query: ReplacementListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<ReplacementView>> {
    return this.replacements.listMine(user.userId, query);
  }

  @Get(':requestId')
  @ApiOperation({ summary: 'One of my requests (404 for anyone else)' })
  get(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplacementView> {
    return this.replacements.getMine(user.userId, requestId);
  }

  @Post(':requestId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw an open request; the booking becomes ACTIVE again' })
  cancel(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReplacementView> {
    return this.replacements.cancel(user.userId, requestId);
  }

  @Post(':requestId/select')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Choose the replacement worker once the request is approved',
    description:
      'Creates the replacement booking (MATCHED, to continue through the normal lifecycle) and closes the old booking as REPLACED. The worker must be eligible and different from the current one. Repeating with the same worker changes nothing.',
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
  @Permissions(PermissionCode.REPLACEMENT_VIEW)
  @ApiOperation({ summary: 'All replacement requests (paginated, filter by status/booking)' })
  list(@Query() query: AdminReplacementListQuery): Promise<Page<AdminReplacementView>> {
    return this.replacements.adminList(query);
  }

  @Get(':requestId')
  @Permissions(PermissionCode.REPLACEMENT_VIEW)
  @ApiOperation({
    summary: 'One request with who asked, who decided and the worker being replaced',
  })
  get(@Param('requestId', ParseUUIDPipe) requestId: string): Promise<AdminReplacementView> {
    return this.replacements.adminGet(requestId);
  }

  @Post(':requestId/approve')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({ summary: 'Approve eligibility (REQUESTED to APPROVED)' })
  async approve(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecisionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminReplacementView> {
    return this.replacements.approve(requestId, dto.remarks, await this.actor(admin));
  }

  @Post(':requestId/reject')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({
    summary: 'Reject a request (remarks required); the booking becomes ACTIVE again',
  })
  async reject(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: DecisionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminReplacementView> {
    return this.replacements.reject(requestId, dto.remarks ?? '', await this.actor(admin));
  }

  @Get(':requestId/candidates')
  @Permissions(PermissionCode.REPLACEMENT_VIEW, PermissionCode.MATCHING_RUN)
  @ApiOperation({
    summary:
      'Alternative workers for the booking requirement (excludes the current worker; audited)',
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
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.REPLACEMENT_MANAGE)
  @ApiOperation({ summary: 'Select the replacement worker on the customer behalf (audited)' })
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
