import {
  Body,
  Controller,
  Get,
  Headers,
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
import { PageQueryDto } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminCategoryListQuery,
  AdminServiceCategoryResponse,
  CreateServiceCategoryDto,
  ServiceCategoryResponse,
  SetCategoryEngagementsDto,
  UpdateServiceCategoryDto,
} from './dto/categories.dto';
import { ServiceCategoriesService } from './service-categories.service';

/** Read-only for every signed-in user (customers choose a category; workers choose roles). Enabled categories only. */
@ApiTags('Service Categories')
@ApiBearerAuth()
@Controller({ path: 'service-categories', version: '1' })
export class ServiceCategoriesController {
  constructor(private readonly categories: ServiceCategoriesService) {}

  @Get()
  @ApiPageResponse(ServiceCategoryResponse)
  @ApiOperation({ summary: 'List enabled service categories (paginated, by name)' })
  list(@Query() query: PageQueryDto): Promise<Page<ServiceCategoryResponse>> {
    return this.categories.listEnabled(query);
  }

  @Get(':categoryId')
  @ApiModelResponse(ServiceCategoryResponse)
  @ApiOperation({ summary: 'One enabled service category (404 if unknown or disabled)' })
  get(@Param('categoryId', ParseUUIDPipe) categoryId: string): Promise<ServiceCategoryResponse> {
    return this.categories.getEnabled(categoryId);
  }
}

@ApiTags('Admin - Service Categories')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Permissions(PermissionCode.CATEGORY_MANAGE)
@Controller({ path: 'admin/service-categories', version: '1' })
export class AdminServiceCategoriesController {
  constructor(
    private readonly categories: ServiceCategoriesService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiPageResponse(AdminServiceCategoryResponse)
  @ApiOperation({ summary: 'List all categories including disabled (paginated)' })
  list(@Query() query: AdminCategoryListQuery): Promise<Page<AdminServiceCategoryResponse>> {
    return this.categories.adminList(query);
  }

  @Get(':categoryId')
  @ApiModelResponse(AdminServiceCategoryResponse)
  @ApiOperation({ summary: 'One category including disabled (ETag for If-Match)' })
  async get(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminServiceCategoryResponse> {
    const category = await this.categories.adminGet(categoryId);
    res.setHeader('ETag', etagOf(category.updatedAt));
    return category;
  }

  @Post()
  @ApiModelResponse(AdminServiceCategoryResponse, { status: 201 })
  @ApiOperation({ summary: 'Add a category (409 CATEGORY_DUPLICATE for an existing code or name)' })
  async create(
    @Body() dto: CreateServiceCategoryDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminServiceCategoryResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.categories.adminCreate(dto, { userId: admin.userId, roles: access.roles });
  }

  @Put(':categoryId/engagements')
  @ApiModelResponse(AdminServiceCategoryResponse)
  @ApiOperation({
    summary: 'Set the engagement types a category offers (empty list = not restricted)',
    description:
      'Once set, booking requests, search and matching for the category accept only these engagement types (422 ENGAGEMENT_NOT_OFFERED). Bookings that already exist are unaffected.',
  })
  async setEngagements(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: SetCategoryEngagementsDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminServiceCategoryResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.categories.adminSetEngagements(categoryId, dto.engagements, {
      userId: admin.userId,
      roles: access.roles,
    });
  }

  @Patch(':categoryId')
  @ApiModelResponse(AdminServiceCategoryResponse)
  @ApiOperation({
    summary: 'Rename, describe, enable or disable a category',
    description:
      'The code is immutable. Disabling hides the category from new selections; workers who already hold it keep it.',
  })
  async update(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateServiceCategoryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<AdminServiceCategoryResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.categories.adminUpdate(
      categoryId,
      dto,
      { userId: admin.userId, roles: access.roles },
      ifMatch,
    );
  }
}
