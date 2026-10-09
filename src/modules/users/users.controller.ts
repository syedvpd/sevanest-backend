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
import { maskMobile } from '../../common/validation/indian-mobile';
import { PermissionCode } from './rbac.constants';
import {
  AdminUserResponse,
  CreateAdminDto,
  MyIdentityResponse,
  UpdateUserStatusDto,
} from './dto/users.dto';
import { AdminAccessService } from './admin-access.service';
import {
  AdminUserListItem,
  AdminUserListQuery,
  ChangeAdminRoleDto,
  PermissionView,
  RoleView,
  SetRolePermissionsDto,
} from './dto/admin-access.dto';
import { UsersService } from './users.service';
import type { UserRecord } from './users.types';

function toAdminView(user: UserRecord): AdminUserResponse {
  return {
    id: user.id,
    type: user.type,
    status: user.status,
    mobile: maskMobile(user.mobile),
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

@ApiTags('Users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Who am I: identity, type, status, roles and permissions' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MyIdentityResponse> {
    const identity = await this.users.getIdentity(user.userId);
    return {
      id: identity.id,
      type: identity.type,
      status: identity.status,
      mobile: identity.mobile,
      email: identity.email,
      roles: identity.roles,
      permissions: identity.permissions,
      createdAt: identity.createdAt,
    };
  }
}

@ApiTags('Admin - Users')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly access: AdminAccessService,
  ) {}

  @Get()
  @Permissions(PermissionCode.USER_VIEW)
  @ApiOperation({
    summary:
      'List accounts (paginated; filter by type and status; mobile masked; roles for admins)',
  })
  listUsers(@Query() query: AdminUserListQuery): Promise<Page<AdminUserListItem>> {
    return this.access.listUsers(query);
  }

  @Post()
  @Permissions(PermissionCode.ADMIN_MANAGE_USERS)
  @ApiOperation({ summary: 'Create an admin account with one role (Super Admin)' })
  async createAdmin(
    @Body() dto: CreateAdminDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AdminUserResponse> {
    const access = await this.users.getAccess(actor.userId);
    const created = await this.users.provisionAdmin(dto, {
      userId: actor.userId,
      roles: access.roles,
    });
    return toAdminView(created);
  }

  @Get(':userId')
  @Permissions(PermissionCode.USER_VIEW)
  @ApiOperation({ summary: 'View an account (mobile masked)' })
  async getUser(@Param('userId', ParseUUIDPipe) userId: string): Promise<AdminUserResponse> {
    return toAdminView(await this.users.getByIdOrThrow(userId));
  }

  @Put(':userId/role')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.ADMIN_MANAGE_USERS)
  @ApiOperation({
    summary: 'Move an admin account to another role (audited)',
    description:
      'Only a Super Admin may grant or take away the Super Admin role; nobody changes their own role; the last active Super Admin cannot be moved. Takes effect on the next request.',
  })
  async changeRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeAdminRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AdminUserListItem> {
    const access = await this.users.getAccess(actor.userId);
    return this.access.changeAdminRole(userId, dto.roleCode, dto.reason, {
      userId: actor.userId,
      roles: access.roles,
    });
  }

  @Patch(':userId/status')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.USER_STATUS_MANAGE)
  @ApiOperation({
    summary: 'Suspend or reactivate a customer, worker or admin account',
    description:
      'Suspended users cannot log in and their sessions are revoked. Changing an admin account additionally requires admin.manage_users. You cannot change your own status.',
  })
  async changeStatus(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AdminUserResponse> {
    const access = await this.users.getAccess(actor.userId);
    const updated = await this.users.changeStatus(
      userId,
      dto.status,
      dto.reason,
      { userId: actor.userId, roles: access.roles },
      access.permissions,
    );
    return toAdminView(updated);
  }
}

/** Roles and what each may do (FRD FM-15/FM-16). Super Admin only: `role.manage` can never be given to another role. */
@ApiTags('Admin - Roles')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin', version: '1' })
export class AdminRolesController {
  constructor(
    private readonly users: UsersService,
    private readonly access: AdminAccessService,
  ) {}

  @Get('roles')
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({
    summary: 'The admin roles with their permissions and how many accounts hold each',
  })
  roles(): Promise<RoleView[]> {
    return this.access.listRoles();
  }

  @Get('permissions')
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({ summary: 'The permission catalog' })
  permissions(): Promise<PermissionView[]> {
    return this.access.listPermissions();
  }

  @Get('roles/:roleCode')
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({ summary: 'One role with its permissions' })
  role(@Param('roleCode') roleCode: string): Promise<RoleView> {
    return this.access.getRole(roleCode);
  }

  @Put('roles/:roleCode/permissions')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({
    summary: 'Set the complete permission set of a role (audited, immediate)',
    description:
      '409 ROLE_IMMUTABLE for SUPER_ADMIN; 422 PERMISSION_RESTRICTED for permissions only the Super Admin may hold; 422 PERMISSION_UNKNOWN. This is how the open permission matrix (Q-11, Q-33) is configured without a code change.',
  })
  async setPermissions(
    @Param('roleCode') roleCode: string,
    @Body() dto: SetRolePermissionsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<RoleView> {
    const access = await this.users.getAccess(actor.userId);
    return this.access.setRolePermissions(roleCode, dto.permissionCodes, {
      userId: actor.userId,
      roles: access.roles,
    });
  }
}
