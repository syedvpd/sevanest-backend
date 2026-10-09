import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { ADMIN_ROLE_CODES } from '../rbac.constants';
import type { AdminRoleCodeValue } from '../rbac.constants';
import { AdminUserResponse } from './users.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class AdminUserListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['CUSTOMER', 'WORKER', 'ADMIN'] })
  @IsOptional()
  @IsEnum(['CUSTOMER', 'WORKER', 'ADMIN'])
  type?: 'CUSTOMER' | 'WORKER' | 'ADMIN';

  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'] })
  @IsOptional()
  @IsEnum(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';
}

export class AdminUserListItem extends AdminUserResponse {
  @ApiProperty({ type: [String], description: 'Role codes (admin accounts).' }) roles!: string[];
}

export class ChangeAdminRoleDto {
  @ApiProperty({ enum: ADMIN_ROLE_CODES })
  @IsIn(ADMIN_ROLE_CODES)
  roleCode!: AdminRoleCodeValue;

  @ApiPropertyOptional({ maxLength: 500, description: 'Recorded in the audit log.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class SetRolePermissionsDto {
  @ApiProperty({
    type: [String],
    description:
      'The complete set of permission codes the role holds after the call (replaces the current set; send [] to remove all).',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_.]{1,60}$/, { each: true })
  permissionCodes!: string[];
}

export class RoleView {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String] }) permissionCodes!: string[];
  @ApiProperty({ description: 'Accounts holding the role.' }) userCount!: number;
}

export class PermissionView {
  @ApiProperty() code!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ description: 'true = can only ever be held by the Super Admin role.' })
  superAdminOnly!: boolean;
}
