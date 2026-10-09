import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { LANGUAGE_CODE } from '../../../common/validation/language';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/*
 * Length caps below are TECHNICAL bounds that stop absurd payloads. The specs set no field limits (Q-12), so they are
 * not product rules and can be revised without a data migration (columns are unbounded text).
 */

/** FRD FM-02: "Non-empty; letters and common name characters". */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
/** Indian PIN code: six digits, first digit 1-9. */
const PINCODE = /^[1-9][0-9]{5}$/;

export class CreateCustomerProfileDto {
  @ApiProperty({ example: 'Asha Rao' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Matches(NAME, { message: "name may contain letters, spaces and . ' - only" })
  name!: string;

  @ApiProperty({ example: 'asha@example.com' })
  @Transform(lowerTrim)
  @IsEmail()
  @Length(3, 254)
  email!: string;

  @ApiProperty({
    example: 'en',
    description: 'Language code; restricted to an allow-list when one is configured.',
  })
  @Transform(trim)
  @IsString()
  @Matches(LANGUAGE_CODE, { message: 'preferredLanguage must be a language code such as "en"' })
  preferredLanguage!: string;
}

/** Only these three fields are client-writable. Status, mobile and ownership are never accepted from the client. */
export class UpdateCustomerProfileDto extends PartialType(CreateCustomerProfileDto) {}

export class CreateAddressDto {
  @ApiProperty({ example: '12-3-45, Lotus Apartments, Road No. 5' })
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  line!: string;

  @ApiProperty({ example: 'Madhapur' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  area!: string;

  @ApiProperty({ example: 'Hyderabad' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  city!: string;

  @ApiProperty({ example: '500081' })
  @Transform(trim)
  @IsString()
  @Matches(PINCODE, { message: 'pincode must be a valid 6-digit Indian PIN code' })
  pincode!: string;

  @ApiPropertyOptional({
    minimum: -90,
    maximum: 90,
    nullable: true,
    description: 'Set together with longitude, or omit both.',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @ApiPropertyOptional({ minimum: -180, maximum: 180, nullable: true })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  @ApiPropertyOptional({
    description: 'Make this the default address (replaces the current default).',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** The default flag changes only through PUT .../default; active state only through DELETE. */
export class UpdateAddressDto extends PartialType(
  OmitType(CreateAddressDto, ['isDefault'] as const),
) {}

export class AdminCustomerListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'VERIFIED'] })
  @IsOptional()
  @IsIn(['PENDING', 'VERIFIED'])
  verificationStatus?: 'PENDING' | 'VERIFIED';

  @ApiPropertyOptional({ description: 'Exact mobile number (any common Indian format).' })
  @IsOptional()
  @IsString()
  @Length(10, 15)
  mobile?: string;
}

export class UpdateVerificationStatusDto {
  @ApiProperty({ enum: ['PENDING', 'VERIFIED'] })
  @IsIn(['PENDING', 'VERIFIED'])
  status!: 'PENDING' | 'VERIFIED';

  @ApiPropertyOptional({ maxLength: 500, description: 'Recorded in the audit log.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class CreateCustomerNoteDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  note!: string;
}

// --- responses -------------------------------------------------------------------------------------------------

export class CustomerProfileResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() preferredLanguage!: string;
  @ApiProperty({ description: 'Verified at signup via OTP; read-only.' }) mobile!: string;
  @ApiProperty({ enum: ['PENDING', 'VERIFIED'] }) verificationStatus!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AddressResponse {
  @ApiProperty() id!: string;
  @ApiProperty() line!: string;
  @ApiProperty() area!: string;
  @ApiProperty() city!: string;
  @ApiProperty() pincode!: string;
  @ApiProperty({ nullable: true }) latitude!: number | null;
  @ApiProperty({ nullable: true }) longitude!: number | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AdminAddressResponse extends AddressResponse {
  @ApiProperty() isActive!: boolean;
}

export class AdminCustomerSummary {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Use with /admin/users/{userId}/status to suspend.' })
  userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ description: 'Masked in lists.' }) mobile!: string | null;
  @ApiProperty() preferredLanguage!: string;
  @ApiProperty({ enum: ['PENDING', 'VERIFIED'] }) verificationStatus!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) accountStatus!: string;
  @ApiProperty() createdAt!: Date;
}

export class AdminCustomerDetail extends AdminCustomerSummary {
  @ApiProperty({ type: [AdminAddressResponse] }) addresses!: AdminAddressResponse[];
  @ApiProperty() updatedAt!: Date;
}

export class CustomerNoteResponse {
  @ApiProperty() id!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty() note!: string;
  @ApiProperty() createdAt!: Date;
}
