import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
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
  @ApiOperation({ summary: 'List enabled service categories (paginated, by name)' })
  list(@Query() query: PageQueryDto): Promise<Page<ServiceCategoryResponse>> {
    return this.categories.listEnabled(query);
  }

  @Get(':categoryId')
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
  @ApiOperation({ summary: 'List all categories including disabled (paginated)' })
  list(@Query() query: AdminCategoryListQuery): Promise<Page<AdminServiceCategoryResponse>> {
    return this.categories.adminList(query);
  }

  @Get(':categoryId')
  @ApiOperation({ summary: 'One category including disabled' })
  get(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
  ): Promise<AdminServiceCategoryResponse> {
    return this.categories.adminGet(categoryId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a category (409 CATEGORY_DUPLICATE for an existing code or name)' })
  async create(
    @Body() dto: CreateServiceCategoryDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminServiceCategoryResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.categories.adminCreate(dto, { userId: admin.userId, roles: access.roles });
  }

  @Patch(':categoryId')
  @ApiOperation({
    summary: 'Rename, describe, enable or disable a category',
    description:
      'The code is immutable. Disabling hides the category from new selections; workers who already hold it keep it.',
  })
  async update(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateServiceCategoryDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminServiceCategoryResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.categories.adminUpdate(categoryId, dto, {
      userId: admin.userId,
      roles: access.roles,
    });
  }
}
