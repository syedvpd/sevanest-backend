import {
  Body,
  Controller,
  Get,
  Headers,
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
import { AvailabilityService } from './availability.service';
import {
  AdminServiceAreaListQuery,
  AdminServiceAreaResponse,
  CreateServiceAreaDto,
  ResolveAreaQuery,
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
  @ApiPageResponse(ServiceAreaResponse)
  @ApiOperation({ summary: 'List enabled service areas (paginated; optional city filter)' })
  list(@Query() query: ServiceAreaListQuery): Promise<Page<ServiceAreaResponse>> {
    return this.areas.listEnabled(query);
  }

  @Get(':areaId')
  @ApiModelResponse(ServiceAreaResponse)
  @ApiOperation({ summary: 'One enabled service area (404 if unknown or disabled)' })
  get(@Param('areaId', ParseUUIDPipe) areaId: string): Promise<ServiceAreaResponse> {
    return this.areas.getEnabled(areaId);
  }
}

/** Customer helper: where is this position? (the "Use my current location" button). */
@ApiTags('Service Areas')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'locations', version: '1' })
export class LocationsController {
  constructor(private readonly areas: ServiceAreasService) {}

  @Get('service-area')
  @ApiModelResponse(ServiceAreaResponse)
  @ApiOperation({
    summary:
      'Resolve a device position and/or geocoded area name to an enabled service area (404 AREA_NOT_FOUND when none)',
  })
  resolve(@Query() query: ResolveAreaQuery): Promise<ServiceAreaResponse> {
    return this.areas.resolve(query);
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
  @ApiPageResponse(AdminServiceAreaResponse)
  @ApiOperation({ summary: 'List all service areas including disabled (paginated)' })
  list(@Query() query: AdminServiceAreaListQuery): Promise<Page<AdminServiceAreaResponse>> {
    return this.areas.adminList(query);
  }

  @Get(':areaId')
  @ApiModelResponse(AdminServiceAreaResponse)
  @ApiOperation({ summary: 'One service area including disabled (ETag for If-Match)' })
  async get(
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminServiceAreaResponse> {
    const area = await this.areas.adminGet(areaId);
    res.setHeader('ETag', etagOf(area.updatedAt));
    return area;
  }

  @Post()
  @ApiModelResponse(AdminServiceAreaResponse, { status: 201 })
  @ApiOperation({ summary: 'Add an area (409 AREA_DUPLICATE when the city already has it)' })
  async create(
    @Body() dto: CreateServiceAreaDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminServiceAreaResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.areas.adminCreate(dto, { userId: admin.userId, roles: access.roles });
  }

  @Patch(':areaId')
  @ApiModelResponse(AdminServiceAreaResponse)
  @ApiOperation({
    summary: 'Rename, move, enable or disable an area',
    description:
      'Disabling hides the area from new selections; workers who already hold it keep it.',
  })
  async update(
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body() dto: UpdateServiceAreaDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<AdminServiceAreaResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.areas.adminUpdate(
      areaId,
      dto,
      { userId: admin.userId, roles: access.roles },
      ifMatch,
    );
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
  @ApiModelResponse(WorkerAvailabilityResponse)
  @ApiOperation({ summary: 'My engagement preference, preferred areas and available time windows' })
  get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerAvailabilityResponse> {
    return this.availability.getMine(user.userId);
  }

  @Patch()
  @ApiModelResponse(WorkerAvailabilityResponse)
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
  @ApiModelResponse(WorkerAvailabilityResponse)
  @Permissions(PermissionCode.WORKER_VIEW)
  @ApiOperation({ summary: "A worker's availability" })
  get(@Param('workerId', ParseUUIDPipe) workerId: string): Promise<WorkerAvailabilityResponse> {
    return this.availability.adminGet(workerId);
  }

  @Patch()
  @ApiModelResponse(WorkerAvailabilityResponse)
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
