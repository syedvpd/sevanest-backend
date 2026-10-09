import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminWorkerDetail,
  AdminWorkerListQuery,
  AdminWorkerSummary,
  CreateWorkerProfileDto,
  SetWorkerCategoriesDto,
  UpdateWorkerProfileDto,
  WorkerProfileResponse,
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
  @ApiOperation({ summary: 'Start my work profile after OTP registration (409 if it exists)' })
  create(
    @Body() dto: CreateWorkerProfileDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerProfileResponse> {
    return this.workers.createMyProfile(user.userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get my profile (404 WORKER_PROFILE_NOT_FOUND until created)',
    description:
      '`missingForSubmission` lists what is still needed, so the app can resume at the first unfinished step.',
  })
  get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerProfileResponse> {
    return this.workers.getMyProfile(user.userId);
  }

  @Patch()
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

  @Post('submit')
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

  @Get()
  @Permissions(PermissionCode.WORKER_VIEW)
  @ApiOperation({ summary: 'List workers (paginated, mobile masked)' })
  list(@Query() query: AdminWorkerListQuery): Promise<Page<AdminWorkerSummary>> {
    return this.workers.adminList(query);
  }

  @Get(':workerId')
  @Permissions(PermissionCode.WORKER_VIEW)
  @ApiOperation({ summary: 'Worker profile including address and emergency contact' })
  get(@Param('workerId', ParseUUIDPipe) workerId: string): Promise<AdminWorkerDetail> {
    return this.workers.adminGet(workerId);
  }

  @Patch(':workerId')
  @Permissions(PermissionCode.WORKER_MANAGE)
  @ApiOperation({ summary: "Edit a worker profile on the worker's behalf (assisted onboarding)" })
  async update(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: UpdateWorkerProfileDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerDetail> {
    const access = await this.users.getAccess(admin.userId);
    return this.workers.adminUpdate(workerId, dto, { userId: admin.userId, roles: access.roles });
  }

  @Put(':workerId/categories')
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
}
