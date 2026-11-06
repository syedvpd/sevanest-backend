import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { IsIndianMobile } from '../../../common/validation/indian-mobile';

/*
 * Length caps are technical abuse bounds, not product rules: the column is unbounded text and the specs set no name
 * limit (Q-12), so a revised limit needs no migration.
 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Same name grammar as a customer/worker name (FRD FM-02): letters, spaces and . ' - only. */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
/** `undefined` means "not supplied"; `null` is a supplied value and must fail validation, never clear a field. */
const supplied = (_object: unknown, value: unknown): boolean => value !== undefined;

/**
 * A self-service change to the signed-in admin's own profile. Only these three fields exist: the DTO is the allow-list,
 * and global validation strips anything else (`role`, `status`, `password`, `userId`, ...), so a client cannot reach
 * authorization data through this path.
 */
export class UpdateAdminProfileDto {
  @ApiPropertyOptional({
    example: 'Priya Sharma',
    minLength: 1,
    maxLength: 200,
    description: "The admin's display name; letters, spaces and . ' - only.",
  })
  @ValidateIf(supplied)
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Matches(NAME, { message: "fullName may contain letters, spaces and . ' - only" })
  fullName?: string;

  @ApiPropertyOptional({
    example: 'priya.sharma@example.com',
    description:
      'Stored lower-cased and trimmed. This is also the admin login identifier; uniqueness is enforced. The platform has no separate e-mail-verification state, so an accepted change is effective immediately (Q-140).',
  })
  @ValidateIf(supplied)
  @Transform(lowerTrim)
  @IsEmail()
  @Length(3, 254)
  email?: string;

  @ApiPropertyOptional({
    example: '+919876543210',
    description:
      'Accepts 10 digits starting 6-9, optionally prefixed with +91, 91 or 0; stored as E.164. Uniqueness is enforced. It is not an admin login factor.',
  })
  @ValidateIf(supplied)
  @IsIndianMobile()
  phoneNumber?: string;
}

/** A short-lived signed link to the current photo renditions. */
export class AdminProfilePhotoView {
  @ApiProperty({ description: 'Signed download URL for the small (card) WebP rendition.' })
  url!: string;

  @ApiProperty({ description: 'Signed download URL for the large WebP rendition.' })
  largeUrl!: string;

  @ApiProperty({ description: 'When both signed URLs stop working; request the profile again.' })
  expiresAt!: Date;

  @ApiProperty({
    description: 'Changes whenever the photo is replaced; usable as a client cache key.',
  })
  cacheKey!: string;
}

/** The signed-in admin's own profile. Never contains a password hash, role-independent permissions or storage keys. */
export class AdminProfileView {
  @ApiProperty({ description: 'The authenticated admin user id.' })
  id!: string;

  @ApiProperty({ nullable: true, type: String, example: 'Priya Sharma' })
  fullName!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'priya.sharma@example.com' })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '+919876543210' })
  phoneNumber!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'OPERATIONS_ADMIN',
    description:
      'The primary role code (the first of `roles`); null only for an unassigned account.',
  })
  role!: string | null;

  @ApiProperty({ type: [String], description: 'Every role code held by the account.' })
  roles!: string[];

  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] })
  status!: string;

  @ApiProperty({
    type: () => AdminProfilePhotoView,
    nullable: true,
    description: 'Null when no photo has been uploaded.',
  })
  photo!: AdminProfilePhotoView | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    description: 'The latest of the account and profile-photo record changes.',
  })
  updatedAt!: Date;
}
