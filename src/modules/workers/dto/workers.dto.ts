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
  IsBoolean,
  Equals,
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

export class WorkerReferenceDto {
  @ApiProperty({ example: 'Mrs. Rao' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: '9876543210' })
  @IsIndianMobile()
  mobile!: string;

  @ApiPropertyOptional({ example: 'Previous employer', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  relationship?: string;
}

/** Maximum references a worker can list: a technical bound, not a policy (the number the business wants is undecided). */
export const MAX_WORKER_REFERENCES = 5;

export class SetWorkerReferencesDto {
  @ApiProperty({
    type: [WorkerReferenceDto],
    maxItems: MAX_WORKER_REFERENCES,
    description:
      'Replaces the whole list. A mobile number may appear once. An empty list clears it.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_WORKER_REFERENCES)
  @ValidateNested({ each: true })
  @Type(() => WorkerReferenceDto)
  references!: WorkerReferenceDto[];
}

export class WorkerReferenceView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() mobile!: string;
  @ApiProperty({ nullable: true, type: String }) relationship!: string | null;
}

export class CreateWorkerProfileDto {
  @ApiProperty({ example: 'Ramesh Kumar' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Matches(NAME, { message: "name may contain letters, spaces and . ' - only" })
  name!: string;
}

/** Staff creating the account and profile of a worker who is helped to register (assisted onboarding, FR-WON-007). */
export class AdminCreateWorkerDto extends CreateWorkerProfileDto {
  @ApiProperty({
    example: '9876543210',
    description:
      'The mobile of the worker. They sign in with an OTP sent to it; staff never hold their login.',
  })
  @IsIndianMobile()
  mobile!: string;
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
    type: Number,
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999)
  expectedSalary?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'hi',
    description: 'Language for my notifications and app. null clears it (platform default).',
    type: String,
  })
  @IsOptional()
  @Matches(LANGUAGE_CODE, { message: 'preferredLanguage must be a language code such as "hi"' })
  preferredLanguage?: string | null;

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

export class SetCriminalDeclarationDto {
  @ApiProperty({
    description:
      'true = I have a criminal record or a pending criminal case; false = I have none. The meaning is the worker own statement (Q-117).',
  })
  @IsBoolean()
  hasCriminalRecord!: boolean;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Only with hasCriminalRecord = true (400 otherwise).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  details?: string;

  @ApiProperty({
    description:
      'Consent: must be true. The worker confirms the statement is true and accepts that it is stored and shown to verification staff.',
  })
  @Equals(true, { message: 'accepted must be true: the declaration needs the worker consent' })
  accepted!: boolean;
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

  @ApiPropertyOptional({ description: 'Part of the name (case-insensitive).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  name?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED'])
  accountStatus?: 'ACTIVE' | 'SUSPENDED';

  @ApiPropertyOptional({ description: 'Only workers who offer this service area.' })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 10, description: 'Average rating at least this.' })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(10)
  minRating?: number;

  @ApiPropertyOptional({
    description:
      'true = only fully verified workers (every required check approved, none due for re-check); false = the others. Verified workers are the ones awaiting any operations follow-up: verification does not change the account status.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  verified?: boolean;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Registered on or after (India date).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'createdFrom must be YYYY-MM-DD' })
  createdFrom?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Registered on or before (India date).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'createdTo must be YYYY-MM-DD' })
  createdTo?: string;
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

export class CriminalDeclarationView {
  @ApiProperty() hasCriminalRecord!: boolean;
  @ApiProperty({ nullable: true, type: String }) details!: string | null;
  @ApiProperty({ description: 'Server time of the latest acceptance.' }) acceptedAt!: Date;
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
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'SEVA00000042',
    description:
      'Human-readable application reference (SEVA + 8 digits), stamped when the profile is submitted. Null while DRAFT.',
  })
  applicationReference!: string | null;
  @ApiProperty({ nullable: true, type: Date }) submittedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Number }) experienceMonths!: number | null;
  @ApiProperty({ nullable: true, type: Number }) expectedSalary!: number | null;
  @ApiProperty({ nullable: true, type: String }) preferredLanguage!: string | null;
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: WorkerAddressResponse, nullable: true })
  address!: WorkerAddressResponse | null;
  @ApiProperty({ type: EmergencyContactResponse, nullable: true })
  emergencyContact!: EmergencyContactResponse | null;
  @ApiProperty({ type: PreviousEmployerResponse, nullable: true })
  previousEmployer!: PreviousEmployerResponse | null;
  @ApiProperty() hasProfilePhoto!: boolean;
  @ApiProperty({
    type: CriminalDeclarationView,
    nullable: true,
    description: 'The criminal self-declaration; null until the worker has made it.',
  })
  criminalDeclaration!: CriminalDeclarationView | null;
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
  @ApiProperty({ nullable: true, description: 'Masked in lists.', type: String }) mobile!:
    string | null;
  @ApiProperty({ enum: ['DRAFT', 'SUBMITTED'] }) onboardingStatus!: string;
  @ApiProperty({ nullable: true, type: String, example: 'SEVA00000042' })
  applicationReference!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) accountStatus!: string;
  @ApiProperty({ type: [WorkerCategoryRef] }) categories!: WorkerCategoryRef[];
  @ApiProperty() createdAt!: Date;
}

export class BlacklistInfo {
  @ApiProperty() at!: Date;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) byUserId!: string | null;
}

export class AdminWorkerDetail extends WorkerProfileResponse {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) accountStatus!: string;
  @ApiProperty({
    description:
      'DEC-09: the emergency contact is not part of this view (emergencyContact is always null here). Use POST /admin/workers/{id}/emergency-contact/reveal with a reason.',
  })
  hasEmergencyContact!: boolean;
  @ApiProperty({
    type: BlacklistInfo,
    nullable: true,
    description: 'Set while the worker is blacklisted (DEC-06).',
  })
  blacklist!: BlacklistInfo | null;
}

export class BlacklistWorkerDto {
  @ApiProperty({ maxLength: 500, description: 'Why; kept on the profile and in the audit log.' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class RevealEmergencyContactDto {
  @ApiProperty({
    minLength: 5,
    maxLength: 300,
    description:
      'Why the contact is needed. Mandatory (422 REASON_REQUIRED when missing or shorter than 5 characters); written to the audit log with the reveal.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Length(0, 300)
  reason?: string;
}

export class RevealedEmergencyContact {
  @ApiProperty() name!: string;
  @ApiProperty() mobile!: string;
}
