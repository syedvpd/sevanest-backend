import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AppSettingView,
  CreateRatingTagDto,
  RatingTagAdminView,
  SetAppSettingDto,
  UpdateRatingTagDto,
} from './dto/platform-config.dto';
import { PlatformConfigService } from './platform-config.service';
import type { ConfigActor } from './platform-config.service';

/** Staff-managed configuration the apps read: start-up settings and the rating tag catalogue. Every change is audited. */
@ApiTags('Admin - Configuration')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin', version: '1' })
export class AdminPlatformConfigController {
  constructor(
    private readonly config: PlatformConfigService,
    private readonly users: UsersService,
  ) {}

  @Get('app-settings')
  @ApiModelResponse(AppSettingView, { isArray: true })
  @Permissions(PermissionCode.CONFIG_MANAGE)
  @ApiOperation({
    summary: 'Every app start-up setting with its current value and where the value comes from',
    description:
      'source DATABASE = set here, ENVIRONMENT = deployment default, UNSET = nothing. GET /app-config serves exactly these values.',
  })
  listSettings(): Promise<AppSettingView[]> {
    return this.config.listSettings();
  }

  @Put('app-settings/:key')
  @ApiModelResponse(AppSettingView)
  @Permissions(PermissionCode.CONFIG_MANAGE)
  @ApiOperation({
    summary: 'Set one app start-up setting (audited)',
    description:
      '404 SETTING_UNKNOWN for a key not in the list. 422 SETTING_VALUE_INVALID for a wrong type or format (versions like 1.4.0, https links, phone, e-mail). The apps see the change at once.',
  })
  async setSetting(
    @Param('key') key: string,
    @Body() dto: SetAppSettingDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AppSettingView> {
    return this.config.setSetting(key, dto.value, await this.actor(admin));
  }

  @Delete('app-settings/:key')
  @ApiModelResponse(AppSettingView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.CONFIG_MANAGE)
  @ApiOperation({ summary: 'Clear a setting so the deployment default applies again (audited)' })
  async clearSetting(
    @Param('key') key: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AppSettingView> {
    return this.config.clearSetting(key, await this.actor(admin));
  }

  @Get('rating-tags')
  @ApiModelResponse(RatingTagAdminView, { isArray: true })
  @Permissions(PermissionCode.CONFIG_MANAGE)
  @ApiOperation({ summary: 'All rating tags, active and retired' })
  listTags(): Promise<RatingTagAdminView[]> {
    return this.config.listTags();
  }

  @Post('rating-tags')
  @ApiModelResponse(RatingTagAdminView, { status: 201 })
  @Permissions(PermissionCode.CONFIG_MANAGE)
  @ApiOperation({
    summary: 'Add a rating tag (audited)',
    description:
      '409 RATING_TAG_EXISTS for a code already used. The tag is offered to customers at once.',
  })
  async createTag(
    @Body() dto: CreateRatingTagDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<RatingTagAdminView> {
    return this.config.createTag(dto, await this.actor(admin));
  }

  @Patch('rating-tags/:code')
  @ApiModelResponse(RatingTagAdminView)
  @Permissions(PermissionCode.CONFIG_MANAGE)
  @ApiOperation({
    summary: 'Rename, reorder, change the sentiment of, or retire a rating tag (audited)',
    description: 'The code never changes. Retiring (isActive false) keeps the tag on old ratings.',
  })
  async updateTag(
    @Param('code') code: string,
    @Body() dto: UpdateRatingTagDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<RatingTagAdminView> {
    return this.config.updateTag(code, dto, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<ConfigActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
