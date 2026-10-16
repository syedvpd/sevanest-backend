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
  Put,
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
  AdminCreateWorkerDto,
  AdminWorkerDetail,
  AdminWorkerListQuery,
  AdminWorkerSummary,
  BlacklistWorkerDto,
  CreateWorkerProfileDto,
  RevealedEmergencyContact,
  RevealEmergencyContactDto,
  SetCriminalDeclarationDto,
  SetWorkerCategoriesDto,
  SetWorkerReferencesDto,
  UpdateWorkerProfileDto,
  WorkerProfileResponse,
  WorkerReferenceView,
} from './dto/workers.dto';
import { WorkersService } from './workers.service';

/** The signed-in worker's own profile. Scoped to the authenticated user, never to an id from the client. */
@ApiTags('Workers')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me', version: '1' })
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Post()
  @ApiModelResponse(WorkerProfileResponse, { status: 201 })
  @ApiOperation({ summary: 'Start my work profile after OTP registration (409 if it exists)' })
  create(
    @Body() dto: CreateWorkerProfileDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerProfileResponse> {
    return this.workers.createMyProfile(user.userId, dto);
  }

  @Get()
  @ApiModelResponse(WorkerProfileResponse)
  @ApiOperation({
    summary: 'Get my profile (404 WORKER_PROFILE_NOT_FOUND until created)',
    description:
      '`missingForSubmission` lists what is still needed, so the app can resume at the first unfinished step.',
  })
  get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerProfileResponse> {
    return this.workers.getMyProfile(user.userId);
  }

  @Patch()
  @ApiModelResponse(WorkerProfileResponse)
  @ApiOperation({
    summary: 'Save a step of my profile (any subset of fields)',
    description:
      'Only the fields sent change. address, emergencyContact and previousEmployer are replaced as a whole; previousEmployer: null clears it. Status, photo and ownership are not writable.',
  })
  update(
    @Body() dto: UpdateWorkerProfileDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerProfileResponse> {
    return this.workers.updateMyProfile(user.userId, dto);
  }

  @Put('categories')
  @ApiModelResponse(WorkerProfileResponse)
  @ApiOperation({
    summary: 'Set my roles (service categories) - replaces the whole set',
    description:
      'New categories must be enabled; categories I already hold may stay even if later disabled.',
  })
  setCategories(
    @Body() dto: SetWorkerCategoriesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerProfileResponse> {
    return this.workers.setMyCategories(user.userId, dto);
  }

  @Put('criminal-declaration')
  @ApiModelResponse(WorkerProfileResponse)
  @ApiOperation({
    summary: 'Save my criminal self-declaration and consent',
    description:
      'Body: hasCriminalRecord (my own statement), details (only when true), accepted (must be true). The server stamps the acceptance time; the saved declaration comes back as criminalDeclaration on this response, on GET /workers/me and on the admin worker detail. It can be repeated: the latest statement replaces the previous one. Saving it never blocks submission or verification.',
  })
  setCriminalDeclaration(
    @Body() dto: SetCriminalDeclarationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerProfileResponse> {
    return this.workers.setMyCriminalDeclaration(user.userId, dto);
  }

  @Get('references')
  @ApiModelResponse(WorkerReferenceView, { isArray: true })
  @ApiOperation({ summary: 'My references (employers or people who can vouch for me)' })
  getReferences(@CurrentUser() user: AuthenticatedUser): Promise<WorkerReferenceView[]> {
    return this.workers.getMyReferences(user.userId);
  }

  @Put('references')
  @ApiModelResponse(WorkerReferenceView, { isArray: true })
  @ApiOperation({
    summary: 'Set my references - replaces the whole list (up to 5; an empty list clears it)',
    description: 'Each mobile once; your own number is refused (400).',
  })
  setReferences(
    @Body() dto: SetWorkerReferencesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerReferenceView[]> {
    return this.workers.setMyReferences(user.userId, dto);
  }

  @Post('submit')
  @ApiModelResponse(WorkerProfileResponse)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit my profile for verification',
    description:
      '422 PROFILE_INCOMPLETE lists what is missing. Repeating the call on a submitted profile changes nothing. Photo and KYC documents are handled outside this module.',
  })
  submit(@CurrentUser() user: AuthenticatedUser): Promise<WorkerProfileResponse> {
    return this.workers.submitMyProfile(user.userId);
  }
}

/** Admin worker management (FR-ADM-005) and assisted onboarding (FR-WON-007). Suspension is via /admin/users/{userId}/status. */
@ApiTags('Admin - Workers')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/workers', version: '1' })
export class AdminWorkersController {
  constructor(
    private readonly workers: WorkersService,
    private readonly users: UsersService,
  ) {}

  @Post()
  @ApiModelResponse(AdminWorkerDetail, { status: 201 })
  @Permissions(PermissionCode.WORKER_MANAGE)
  @ApiOperation({
    summary:
      'Create a worker account and empty profile for a mobile (assisted onboarding, audited)',
    description:
      '409 MOBILE_IN_USE (a customer or staff number), 409 WORKER_PROFILE_EXISTS. The worker signs in with an OTP to that number.',
  })
  async create(
    @Body() dto: AdminCreateWorkerDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerDetail> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.adminCreate(dto, { userId: admin.userId, roles: access.roles });
  }

  @Get()
  @ApiPageResponse(AdminWorkerSummary)
  @Permissions(PermissionCode.WORKER_VIEW)
  @ApiOperation({ summary: 'List workers (paginated, mobile masked)' })
  list(@Query() query: AdminWorkerListQuery): Promise<Page<AdminWorkerSummary>> {
    return this.workers.adminList(query);
  }

  @Get(':workerId')
  @ApiModelResponse(AdminWorkerDetail)
  @Permissions(PermissionCode.WORKER_VIEW)
  @ApiOperation({ summary: 'Worker profile including address and emergency contact' })
  async get(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerDetail> {
    const access = await this.users.getAccess(admin.userId);
    const detail = await this.workers.adminRead(workerId, {
      userId: admin.userId,
      roles: access.roles,
    });
    res.setHeader('ETag', etagOf(detail.updatedAt));
    return detail;
  }

  @Patch(':workerId')
  @ApiModelResponse(AdminWorkerDetail)
  @Permissions(PermissionCode.WORKER_MANAGE)
  @ApiOperation({
    summary: "Edit a worker profile on the worker's behalf (assisted onboarding)",
    description:
      'Send If-Match with the ETag of the GET to refuse the edit (412 STALE_VERSION) when someone else changed the profile meanwhile.',
  })
  async update(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: UpdateWorkerProfileDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<AdminWorkerDetail> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.adminUpdate(
      workerId,
      dto,
      { userId: admin.userId, roles: access.roles },
      ifMatch,
    );
  }

  @Get(':workerId/references')
  @ApiModelResponse(WorkerReferenceView, { isArray: true })
  @Permissions(PermissionCode.WORKER_VIEW)
  @ApiOperation({ summary: "A worker's references (audited read: third-party personal data)" })
  async references(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<WorkerReferenceView[]> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.adminReferences(workerId, { userId: admin.userId, roles: access.roles });
  }

  @Put(':workerId/categories')
  @ApiModelResponse(AdminWorkerDetail)
  @Permissions(PermissionCode.WORKER_MANAGE)
  @ApiOperation({ summary: "Set a worker's roles (service categories) on their behalf" })
  async setCategories(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: SetWorkerCategoriesDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerDetail> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.adminSetCategories(workerId, dto, {
      userId: admin.userId,
      roles: access.roles,
    });
  }

  @Post(':workerId/blacklist')
  @ApiModelResponse(AdminWorkerDetail)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.WORKER_BLACKLIST)
  @ApiOperation({
    summary: 'Blacklist a worker (reason required, audited)',
    description:
      'The worker leaves search, matching and eligibility at once, their account is suspended (sessions end), and staff get an alert for each open booking they hold. Repeating is safe. Only a Super Admin can lift it.',
  })
  async blacklist(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: BlacklistWorkerDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerDetail> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.blacklist(workerId, dto.reason, {
      userId: admin.userId,
      roles: access.roles,
    });
  }

  @Post(':workerId/blacklist/lift')
  @ApiModelResponse(AdminWorkerDetail)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.WORKER_BLACKLIST_LIFT)
  @ApiOperation({
    summary: 'Lift a blacklisting (Super Admin only; reason required, audited)',
    description:
      'The account is reactivated. The worker is searchable again only if still verified.',
  })
  async liftBlacklist(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: BlacklistWorkerDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerDetail> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.liftBlacklist(workerId, dto.reason, {
      userId: admin.userId,
      roles: access.roles,
    });
  }

  @Post(':workerId/emergency-contact/reveal')
  @ApiModelResponse(RevealedEmergencyContact)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.WORKER_REVEAL_EMERGENCY_CONTACT)
  @ApiOperation({
    summary: "Reveal a worker's emergency contact (reason required; every reveal is audited)",
    description:
      'The general staff profile never contains the emergency contact. 422 without a reason; 404 EMERGENCY_CONTACT_NOT_FOUND when none is on file.',
  })
  async revealEmergencyContact(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: RevealEmergencyContactDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<RevealedEmergencyContact> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.revealEmergencyContact(workerId, dto.reason, {
      userId: admin.userId,
      roles: access.roles,
    });
  }
}
