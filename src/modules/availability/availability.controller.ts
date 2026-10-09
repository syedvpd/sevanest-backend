import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { AvailabilityService } from './availability.service';
import {
  AdminServiceAreaListQuery,
  AdminServiceAreaResponse,
  CreateServiceAreaDto,
  ServiceAreaListQuery,
  ServiceAreaResponse,
  UpdateAvailabilityDto,
  UpdateServiceAreaDto,
  WorkerAvailabilityResponse,
} from './dto/availability.dto';
import { ServiceAreasService } from './service-areas.service';

/** Read-only for every signed-in user: enabled service areas (workers choose preferred locations; customers choose a location). */
@ApiTags('Service Areas')
@ApiBearerAuth()
@Controller({ path: 'service-areas', version: '1' })
export class ServiceAreasController {
  constructor(private readonly areas: ServiceAreasService) {}

  @Get()
  @ApiOperation({ summary: 'List enabled service areas (paginated; optional city filter)' })
  list(@Query() query: ServiceAreaListQuery): Promise<Page<ServiceAreaResponse>> {
    return this.areas.listEnabled(query);
  }

  @Get(':areaId')
  @ApiOperation({ summary: 'One enabled service area (404 if unknown or disabled)' })
  get(@Param('areaId', ParseUUIDPipe) areaId: string): Promise<ServiceAreaResponse> {
    return this.areas.getEnabled(areaId);
  }
}

@ApiTags('Admin - Service Areas')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Permissions(PermissionCode.AREA_MANAGE)
@Controller({ path: 'admin/service-areas', version: '1' })
export class AdminServiceAreasController {
  constructor(
    private readonly areas: ServiceAreasService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all service areas including disabled (paginated)' })
  list(@Query() query: AdminServiceAreaListQuery): Promise<Page<AdminServiceAreaResponse>> {
    return this.areas.adminList(query);
  }

  @Get(':areaId')
  @ApiOperation({ summary: 'One service area including disabled' })
  get(@Param('areaId', ParseUUIDPipe) areaId: string): Promise<AdminServiceAreaResponse> {
    return this.areas.adminGet(areaId);
  }

  @Post()
  @ApiOperation({ summary: 'Add an area (409 AREA_DUPLICATE when the city already has it)' })
  async create(
    @Body() dto: CreateServiceAreaDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminServiceAreaResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.areas.adminCreate(dto, { userId: admin.userId, roles: access.roles });
  }

  @Patch(':areaId')
  @ApiOperation({
    summary: 'Rename, move, enable or disable an area',
    description:
      'Disabling hides the area from new selections; workers who already hold it keep it.',
  })
  async update(
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body() dto: UpdateServiceAreaDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminServiceAreaResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.areas.adminUpdate(areaId, dto, { userId: admin.userId, roles: access.roles });
  }
}

/** The signed-in worker's own availability. */
@ApiTags('Worker Availability')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/availability', version: '1' })
export class WorkerAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @ApiOperation({ summary: 'My engagement preference, preferred areas and available time windows' })
  get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerAvailabilityResponse> {
    return this.availability.getMine(user.userId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Save my availability (any subset; each part sent replaces the stored one)',
    description:
      'Windows are daily "HH:mm" ranges in local time; start must be before end and windows must not overlap. Areas must be enabled service areas.',
  })
  update(
    @Body() dto: UpdateAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerAvailabilityResponse> {
    return this.availability.updateMine(user.userId, dto);
  }
}

@ApiTags('Admin - Worker Availability')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/workers/:workerId/availability', version: '1' })
export class AdminWorkerAvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @Permissions(PermissionCode.WORKER_VIEW)
  @ApiOperation({ summary: "A worker's availability" })
  get(@Param('workerId', ParseUUIDPipe) workerId: string): Promise<WorkerAvailabilityResponse> {
    return this.availability.adminGet(workerId);
  }

  @Patch()
  @Permissions(PermissionCode.WORKER_MANAGE)
  @ApiOperation({ summary: "Edit a worker's availability on their behalf (assisted onboarding)" })
  async update(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: UpdateAvailabilityDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<WorkerAvailabilityResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.availability.adminUpdate(workerId, dto, {
      userId: admin.userId,
      roles: access.roles,
    });
  }
}
