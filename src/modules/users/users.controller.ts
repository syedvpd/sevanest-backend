import {
  Body,
  Controller,
  Get,
  Header,
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
import type { Response } from 'express';
import { etagOf } from '../../common/concurrency/if-match';
import { RequireIfMatch } from '../../common/concurrency/if-match.guard';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { maskMobile } from '../../common/validation/indian-mobile';
import { PermissionCode } from './rbac.constants';
import {
  AdminUserResponse,
  NotificationPreferencesView,
  UpdateNotificationPreferencesDto,
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
  @ApiModelResponse(MyIdentityResponse)
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

@ApiTags('Users')
@ApiBearerAuth()
@Controller({ path: 'users/me/notification-preferences', version: '1' })
export class NotificationPreferencesController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiModelResponse(NotificationPreferencesView)
  @ApiOperation({ summary: 'My notification preferences (e-mail on/off)' })
  async get(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPreferencesView> {
    return { email: await this.users.getEmailPreference(user.userId) };
  }

  @Put()
  @ApiModelResponse(NotificationPreferencesView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Turn e-mail notifications on or off for me',
    description:
      'E-mail is only ever sent when the platform has an e-mail channel configured and an address on file for you.',
  })
  async set(
    @Body() dto: UpdateNotificationPreferencesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NotificationPreferencesView> {
    return { email: await this.users.setEmailPreference(user.userId, dto.email) };
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
  @ApiPageResponse(AdminUserListItem)
  @Permissions(PermissionCode.USER_VIEW)
  @ApiOperation({
    summary:
      'List accounts (paginated; filter by type and status; mobile masked; roles for admins)',
  })
  listUsers(@Query() query: AdminUserListQuery): Promise<Page<AdminUserListItem>> {
    return this.access.listUsers(query);
  }

  @Post()
  @ApiModelResponse(AdminUserResponse, { status: 201 })
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
  @ApiModelResponse(AdminUserResponse)
  @Permissions(PermissionCode.USER_VIEW)
  @ApiOperation({ summary: 'View an account (mobile masked)' })
  async getUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminUserResponse> {
    const user = await this.users.getByIdOrThrow(userId);
    res.setHeader('ETag', etagOf(user.updatedAt));
    return toAdminView(user);
  }

  @Put(':userId/role')
  @RequireIfMatch()
  @ApiModelResponse(AdminUserListItem)
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
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<AdminUserListItem> {
    const access = await this.users.getAccess(actor.userId);
    return this.access.changeAdminRole(
      userId,
      dto.roleCode,
      dto.reason,
      { userId: actor.userId, roles: access.roles },
      ifMatch,
    );
  }

  @Post(':userId/password-reset')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Permissions(PermissionCode.ADMIN_MANAGE_USERS)
  @ApiOperation({
    summary: 'Set a new temporary password for another admin (Super Admin; shown once)',
    description:
      'For an admin who is locked out or forgot the password. The new password is returned ONCE in this response and never stored in clear; every session of that admin is revoked; the admin must change it with POST /admin/account/password. 422 for a non-admin account or your own account.',
  })
  async resetPassword(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ temporaryPassword: string }> {
    const access = await this.users.getAccess(actor.userId);
    return this.users.resetAdminPassword(userId, { userId: actor.userId, roles: access.roles });
  }

  @Patch(':userId/status')
  @RequireIfMatch()
  @ApiModelResponse(AdminUserResponse)
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
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<AdminUserResponse> {
    const access = await this.users.getAccess(actor.userId);
    const updated = await this.users.changeStatus(
      userId,
      dto.status,
      dto.reason,
      { userId: actor.userId, roles: access.roles },
      access.permissions,
      ifMatch,
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
  @ApiModelResponse(RoleView, { isArray: true })
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({
    summary: 'The admin roles with their permissions and how many accounts hold each',
  })
  roles(): Promise<RoleView[]> {
    return this.access.listRoles();
  }

  @Get('permissions')
  @ApiModelResponse(PermissionView, { isArray: true })
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({ summary: 'The permission catalog' })
  permissions(): Promise<PermissionView[]> {
    return this.access.listPermissions();
  }

  @Get('roles/:roleCode')
  @ApiModelResponse(RoleView)
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({ summary: 'One role with its permissions' })
  role(@Param('roleCode') roleCode: string): Promise<RoleView> {
    return this.access.getRole(roleCode);
  }

  @Put('roles/:roleCode/permissions')
  @ApiModelResponse(RoleView)
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
