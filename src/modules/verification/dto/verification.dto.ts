import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Mirrors the Prisma enums; kept here so the API contract does not depend on generated types. */
export const CHECK_TYPES = [
  'IDENTITY',
  'ADDRESS',
  'EMERGENCY_CONTACT',
  'PREVIOUS_EMPLOYMENT',
  'POLICE_VERIFICATION',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_STATUSES = [
  'NOT_SUBMITTED',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
] as const;
export type StoredCheckStatus = (typeof CHECK_STATUSES)[number];
/** RECHECK_DUE is derived (an approval whose recheck date has been reached), never stored. */
export type EffectiveCheckStatus = StoredCheckStatus | 'RECHECK_DUE';
export type VerificationLevel = 'VERIFIED' | 'IN_PROGRESS' | 'NOT_STARTED';

export class RequestDocumentUploadDto {
  @ApiProperty({ example: 'application/pdf' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  contentType!: string;

  @ApiProperty({ example: 250000, description: 'Size in bytes of the file you will upload.' })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  sizeBytes!: number;
}

export class ApproveCheckDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  remarks?: string;

  @ApiPropertyOptional({
    example: '2027-10-09',
    description: 'India date after which this approval stops counting and a re-check is due.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'recheckAt must be a date in YYYY-MM-DD form' })
  recheckAt?: string;
}

export class RemarksDto {
  @ApiProperty({ maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  remarks!: string;
}

export class SetRequirementsDto {
  @ApiProperty({ enum: CHECK_TYPES, isArray: true })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(CHECK_TYPES.length)
  @IsEnum(CHECK_TYPES, { each: true })
  checkTypes!: CheckType[];
}

export class VerificationQueueQuery extends PageQueryDto {
  @ApiPropertyOptional({
    enum: CHECK_STATUSES,
    description: 'Default: checks waiting for a person (SUBMITTED and IN_REVIEW).',
  })
  @IsOptional()
  @IsEnum(CHECK_STATUSES)
  status?: StoredCheckStatus;

  @ApiPropertyOptional({ enum: CHECK_TYPES })
  @IsOptional()
  @IsEnum(CHECK_TYPES)
  checkType?: CheckType;
}

export class DocumentView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['PENDING_UPLOAD', 'UPLOADED'] }) status!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ description: 'False while the document is still part of the open draft.' })
  submitted!: boolean;
  @ApiProperty() createdAt!: Date;
}

export class CheckView {
  @ApiProperty({ enum: CHECK_TYPES }) checkType!: CheckType;
  @ApiProperty({
    enum: [...CHECK_STATUSES, 'RECHECK_DUE'],
    description: 'RECHECK_DUE = approved, but the re-check date has been reached.',
  })
  status!: EffectiveCheckStatus;
  @ApiProperty() required!: boolean;
  @ApiProperty({ nullable: true }) submittedAt!: Date | null;
  @ApiProperty({ nullable: true }) reviewedAt!: Date | null;
  @ApiProperty({ nullable: true, description: 'Reason given when a check was rejected.' })
  remarks!: string | null;
  @ApiProperty({ nullable: true, example: '2027-10-09' }) recheckAt!: string | null;
  @ApiProperty({ type: [DocumentView] }) documents!: DocumentView[];
}

export class WorkerVerificationResponse {
  @ApiProperty({
    enum: ['VERIFIED', 'IN_PROGRESS', 'NOT_STARTED'],
    description: 'VERIFIED only when every required check is approved and not due for re-check.',
  })
  level!: VerificationLevel;
  @ApiProperty({ enum: CHECK_TYPES, isArray: true }) requiredChecks!: CheckType[];
  @ApiProperty({ type: [CheckView] }) checks!: CheckView[];
}

export class UploadInstruction {
  @ApiProperty({ description: 'Short-lived signed URL. Do not log or share it.' }) url!: string;
  @ApiProperty() method!: 'PUT';
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() maxBytes!: number;
  @ApiProperty() contentType!: string;
}

export class DocumentUploadResponse {
  @ApiProperty() documentId!: string;
  @ApiProperty({ enum: CHECK_TYPES }) checkType!: CheckType;
  @ApiProperty({ type: UploadInstruction }) upload!: UploadInstruction;
}

export class QueueItem {
  @ApiProperty() checkId!: string;
  @ApiProperty() workerId!: string;
  @ApiProperty({ enum: CHECK_TYPES }) checkType!: CheckType;
  @ApiProperty({ enum: CHECK_STATUSES }) status!: StoredCheckStatus;
  @ApiProperty({ nullable: true }) submittedAt!: Date | null;
  @ApiProperty() uploadedDocuments!: number;
}

export class EventView {
  @ApiProperty({ nullable: true }) fromStatus!: StoredCheckStatus | null;
  @ApiProperty() toStatus!: StoredCheckStatus;
  @ApiProperty() actorUserId!: string;
  @ApiProperty({ nullable: true }) remarks!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class AdminCheckView extends CheckView {
  @ApiProperty() checkId!: string;
  @ApiProperty({ nullable: true }) reviewerUserId!: string | null;
  @ApiProperty({ type: [EventView], description: 'Full history, oldest first.' })
  history!: EventView[];
}

export class AdminWorkerVerificationResponse {
  @ApiProperty() workerId!: string;
  @ApiProperty({ enum: ['VERIFIED', 'IN_PROGRESS', 'NOT_STARTED'] }) level!: VerificationLevel;
  @ApiProperty({ enum: CHECK_TYPES, isArray: true }) requiredChecks!: CheckType[];
  @ApiProperty({ type: [AdminCheckView] }) checks!: AdminCheckView[];
}

export class DocumentLinkResponse {
  @ApiProperty({ description: 'Short-lived signed URL. Do not log or share it.' }) url!: string;
  @ApiProperty() expiresAt!: Date;
}

export class RequirementsResponse {
  @ApiProperty({ enum: CHECK_TYPES, isArray: true }) checkTypes!: CheckType[];
}
