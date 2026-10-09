import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { IsIndianMobile } from '../../../common/validation/indian-mobile';
import { LANGUAGE_CODE } from '../../../common/validation/language';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/*
 * Length and size caps are TECHNICAL bounds that stop absurd payloads and fit the column types. The specs set no field
 * limits (Q-12), so they are not product rules.
 */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const PINCODE = /^[1-9][0-9]{5}$/;

export class WorkerAddressDto {
  @ApiProperty({ example: '4-5-6, Gandhi Nagar' })
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  line!: string;

  @ApiProperty({ example: 'Kukatpally' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  area!: string;

  @ApiProperty({ example: 'Hyderabad' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  city!: string;

  @ApiProperty({ example: '500072' })
  @Transform(trim)
  @IsString()
  @Matches(PINCODE, { message: 'pincode must be a valid 6-digit Indian PIN code' })
  pincode!: string;
}

export class EmergencyContactDto {
  @ApiProperty({ example: 'Lakshmi Devi' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Matches(NAME, { message: "name may contain letters, spaces and . ' - only" })
  name!: string;

  @ApiProperty({ example: '9876543210' })
  @IsIndianMobile()
  mobile!: string;
}

export class PreviousEmployerDto {
  @ApiProperty({ example: 'Mr. Sharma' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: '9876543210' })
  @IsIndianMobile()
  mobile!: string;
}

export class CreateWorkerProfileDto {
  @ApiProperty({ example: 'Ramesh Kumar' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Matches(NAME, { message: "name may contain letters, spaces and . ' - only" })
  name!: string;
}

/**
 * Step-by-step onboarding saves (FRD FM-04: "progress saved between steps"): every field is optional, only the fields sent
 * change, and a nested group (address, emergency contact, previous employer) is replaced as a whole. Server-controlled
 * fields (status, photo, ownership) are not accepted.
 */
export class UpdateWorkerProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Matches(NAME, { message: "name may contain letters, spaces and . ' - only" })
  name?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1200, description: 'Total experience in months.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1200)
  experienceMonths?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Amount in rupees, positive. null clears it. The period is not defined by the specifications.',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999)
  expectedSalary?: number | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['en', 'hi'],
    description: 'Replaces the whole list; at least one.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(LANGUAGE_CODE, {
    each: true,
    message: 'each language must be a language code such as "en"',
  })
  languages?: string[];

  @ApiPropertyOptional({ type: WorkerAddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkerAddressDto)
  address?: WorkerAddressDto;

  @ApiPropertyOptional({ type: EmergencyContactDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergencyContact?: EmergencyContactDto;

  @ApiPropertyOptional({
    type: PreviousEmployerDto,
    nullable: true,
    description: 'Optional; null clears it.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PreviousEmployerDto)
  previousEmployer?: PreviousEmployerDto | null;
}

export class SetWorkerCategoriesDto {
  @ApiProperty({
    type: [String],
    description: "The worker's roles (service categories). Replaces the whole set; at least one.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  categoryIds!: string[];
}

export class AdminWorkerListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['DRAFT', 'SUBMITTED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'SUBMITTED'])
  onboardingStatus?: 'DRAFT' | 'SUBMITTED';

  @ApiPropertyOptional({ description: 'Only workers who offer this category.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Exact mobile number (any common Indian format).' })
  @IsOptional()
  @IsString()
  @Length(10, 15)
  mobile?: string;
}

// --- responses -------------------------------------------------------------------------------------------------

export class WorkerCategoryRef {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({
    description: 'False when an admin disabled the category after the worker chose it.',
  })
  isEnabled!: boolean;
}

export class WorkerAddressResponse extends WorkerAddressDto {}
export class EmergencyContactResponse extends EmergencyContactDto {}
export class PreviousEmployerResponse extends PreviousEmployerDto {}

/**
 * The worker's own profile. Private data (address, emergency contact, previous employer) is returned to the owner and to
 * admins with worker.view only. The storage reference of the photo and any KYC data are never returned.
 */
export class WorkerProfileResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'From the verified account; read-only.' }) mobile!: string;
  @ApiProperty({ enum: ['DRAFT', 'SUBMITTED'] }) onboardingStatus!: string;
  @ApiProperty({ nullable: true }) submittedAt!: Date | null;
  @ApiProperty({ nullable: true }) experienceMonths!: number | null;
  @ApiProperty({ nullable: true }) expectedSalary!: number | null;
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: WorkerAddressResponse, nullable: true })
  address!: WorkerAddressResponse | null;
  @ApiProperty({ type: EmergencyContactResponse, nullable: true })
  emergencyContact!: EmergencyContactResponse | null;
  @ApiProperty({ type: PreviousEmployerResponse, nullable: true })
  previousEmployer!: PreviousEmployerResponse | null;
  @ApiProperty() hasProfilePhoto!: boolean;
  @ApiProperty({ type: [WorkerCategoryRef] }) categories!: WorkerCategoryRef[];
  @ApiProperty({
    type: [String],
    description: 'What is still missing before the profile can be submitted (stable names).',
  })
  missingForSubmission!: string[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AdminWorkerSummary {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Use with /admin/users/{userId}/status to suspend.' })
  userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, description: 'Masked in lists.' }) mobile!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'SUBMITTED'] }) onboardingStatus!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) accountStatus!: string;
  @ApiProperty({ type: [WorkerCategoryRef] }) categories!: WorkerCategoryRef[];
  @ApiProperty() createdAt!: Date;
}

export class AdminWorkerDetail extends WorkerProfileResponse {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) accountStatus!: string;
}
