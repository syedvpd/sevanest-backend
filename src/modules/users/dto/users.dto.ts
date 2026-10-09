import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ADMIN_ROLE_CODES } from '../rbac.constants';
import type { AdminRoleCodeValue } from '../rbac.constants';

const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateAdminDto {
  @ApiProperty({ example: 'ops.lead@example.com' })
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Never returned by any endpoint. The minimum length is configuration (ADMIN_PASSWORD_MIN_LENGTH). */
  @ApiProperty({ writeOnly: true })
  @IsString()
  @MaxLength(256)
  password!: string;

  @ApiProperty({ enum: ADMIN_ROLE_CODES })
  @IsIn(ADMIN_ROLE_CODES)
  roleCode!: AdminRoleCodeValue;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] })
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status!: 'ACTIVE' | 'SUSPENDED';

  @ApiPropertyOptional({ maxLength: 500, description: 'Recorded in the audit log.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** The caller's own identity: who they are, what they are, and what the server allows them to do. */
export class MyIdentityResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKER', 'ADMIN'] }) type!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) status!: string;
  @ApiProperty({ nullable: true }) mobile!: string | null;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ type: [String], description: 'Role codes (admins only).' }) roles!: string[];
  @ApiProperty({ type: [String], description: 'Permission codes granted through the roles.' })
  permissions!: string[];
  @ApiProperty() createdAt!: Date;
}

/** Admin view of an account. The mobile number is masked (routine screens, FR-SEC-006). */
export class AdminUserResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKER', 'ADMIN'] }) type!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) status!: string;
  @ApiProperty({ nullable: true }) mobile!: string | null;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
