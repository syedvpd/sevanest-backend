import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { REJECTION_CODES } from '../verification-policy';
import type { RejectionCode, SlaFlag } from '../verification-policy';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Mirrors the Prisma enums; kept here so the API contract does not depend on generated types. */
export const CHECK_TYPES = [
  'IDENTITY',
  'ADDRESS',
  'EMERGENCY_CONTACT',
  'PREVIOUS_EMPLOYMENT',
  'POLICE_VERIFICATION',
  'SKILL_CERTIFICATE',
  'LICENSE',
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

/**
 * Overall worker status shown to staff and in the worker app (D-90). Derived from the stored checks plus two stored stamps (final
 * sign-off, activation); never written directly.
 */
export const APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACTION_REQUIRED',
  'VERIFIED',
  'ACTIVE',
  'REJECTED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

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

export class RejectCheckDto {
  @ApiProperty({ enum: REJECTION_CODES })
  @IsIn(REJECTION_CODES)
  reasonCode!: RejectionCode;

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'Optional for every code except OTHER, where it is the mandatory explanation. When omitted the standard wording of the code is stored as the remarks the worker sees.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  remarks?: string;
}

export class ReleaseReviewDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class ReassignReviewDto {
  @ApiProperty({ description: 'Admin user id of the new reviewer (needs verification.review).' })
  @IsUUID()
  reviewerUserId!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class AddNoteDto {
  @ApiProperty({
    enum: ['CALL', 'REVIEW'],
    description:
      'CALL = employer or phone call log; REVIEW = reviewer note. Staff only, never shown to the worker.',
  })
  @IsIn(['CALL', 'REVIEW'])
  kind!: 'CALL' | 'REVIEW';

  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  body!: string;
}

export class DocumentDetailsDto {
  @ApiPropertyOptional({
    description:
      'The document number as printed. Only the last four characters are kept (masked as XXXX-XXXX-1234); the full number is never stored or logged.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(4, 40)
  documentNumber?: string;

  @ApiPropertyOptional({
    example: '2027-10-09',
    description: 'Validity end of the document. Must be a future date.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expiresOn must be a date in YYYY-MM-DD form' })
  expiresOn?: string;
}

export class SignOffDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  remarks?: string;
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

  @ApiPropertyOptional({
    enum: ['me'],
    description:
      'My Reviews: only checks assigned to the signed-in reviewer (resolved from the token, never from the request). Cannot be combined with reviewerId.',
  })
  @IsOptional()
  @IsIn(['me'])
  assignedTo?: 'me';

  @ApiPropertyOptional({ description: 'Only checks assigned to this reviewer (user id).' })
  @IsOptional()
  @IsUUID()
  reviewerId?: string;

  @ApiPropertyOptional({ description: 'Only workers who offer this service category.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Part of the worker name (case-insensitive).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  search?: string;
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
    enum: REJECTION_CODES,
    nullable: true,
    type: String,
    description: 'Why the check was rejected (status REJECTED only).',
  })
  rejectionCode!: RejectionCode | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Standard worker-facing wording of the rejection code.',
  })
  rejectionMessage!: string | null;
  @ApiProperty({ description: 'true = disqualifying rejection: the check cannot be resubmitted.' })
  terminal!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'XXXX-XXXX-1234',
    description: 'Last four characters only.',
  })
  maskedDocumentNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-10-09' })
  documentExpiresOn!: string | null;
  @ApiProperty({
    enum: [...CHECK_STATUSES, 'RECHECK_DUE'],
    description: 'RECHECK_DUE = approved, but the re-check date has been reached.',
  })
  status!: EffectiveCheckStatus;
  @ApiProperty() required!: boolean;
  @ApiProperty({ nullable: true, type: Date }) submittedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) reviewedAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'Reason given when a check was rejected.',
    type: String,
  })
  remarks!: string | null;
  @ApiProperty({ nullable: true, example: '2027-10-09', type: String }) recheckAt!: string | null;
  @ApiProperty({ type: [DocumentView] }) documents!: DocumentView[];
}

export class WorkerVerificationResponse {
  @ApiProperty({ nullable: true, type: String, example: 'SEVA00000042' }) applicationReference!:
    string | null;
  @ApiProperty({
    enum: APPLICATION_STATUSES,
    description: 'Overall status; see the verification README for the meaning of each value.',
  })
  applicationStatus!: ApplicationStatus;
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
  @ApiProperty({ nullable: true, type: String, example: 'SEVA00000042' }) applicationReference!:
    string | null;
  @ApiProperty() checkId!: string;
  @ApiProperty({
    description:
      'WorkerProfile id. It is also the application identity: there is no separate application number.',
  })
  workerId!: string;
  @ApiProperty() workerName!: string;
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'When the worker submitted the profile for verification (application submission time).',
  })
  applicationSubmittedAt!: Date | null;
  @ApiProperty({ enum: CHECK_TYPES }) checkType!: CheckType;
  @ApiProperty({ enum: CHECK_STATUSES }) status!: StoredCheckStatus;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'When this check was submitted for review.',
  })
  submittedAt!: Date | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Persisted reviewer (user id), set by start-review. Null = unassigned. Admin display names are not stored.',
  })
  reviewerUserId!: string | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'When the reviewer took the check into review.',
  })
  claimedAt!: Date | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'Submission SLA: 24 business hours (09:00-19:00 IST, Monday to Saturday) after the check was submitted.',
  })
  dueAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'Claim SLA: 2 hours after the claim.' })
  claimDueAt!: Date | null;
  @ApiProperty({
    enum: ['OVERDUE', 'STALLED_CLAIM'],
    isArray: true,
    description:
      'OVERDUE = still undecided past dueAt; STALLED_CLAIM = claimed more than 2 hours ago and still undecided.',
  })
  slaFlags!: SlaFlag[];
  @ApiProperty({ description: 'slaFlags contains OVERDUE.' }) isOverdue!: boolean;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'When the check was approved or rejected.',
  })
  decidedAt!: Date | null;
  @ApiProperty() uploadedDocuments!: number;
}

export class EventView {
  @ApiProperty({ nullable: true, type: String }) fromStatus!: StoredCheckStatus | null;
  @ApiProperty() toStatus!: StoredCheckStatus;
  @ApiProperty() actorUserId!: string;
  @ApiProperty({ nullable: true, type: String }) remarks!: string | null;
  @ApiProperty() createdAt!: Date;
}

export const DOCUMENT_AVAILABILITY = ['AVAILABLE', 'NOT_UPLOADED', 'DISCARDED'] as const;
export type DocumentAvailability = (typeof DOCUMENT_AVAILABILITY)[number];

/** Admin view of a document: metadata only, never the storage key or a link (use the link endpoint). */
export class AdminDocumentView extends DocumentView {
  @ApiProperty({
    description:
      'Same value as id: the id for GET /admin/verification/documents/{documentId}/link.',
  })
  documentId!: string;
  @ApiProperty({
    description: 'The check this document belongs to (the id the decision endpoints take).',
  })
  checkId!: string;
  @ApiProperty({ enum: CHECK_TYPES, description: 'Type of the check this document belongs to.' })
  checkType!: CheckType;
  @ApiProperty({
    enum: CHECK_TYPES,
    description:
      'The check this document is evidence for (the document type is the check type: no finer type is stored).',
  })
  documentType!: CheckType;
  @ApiProperty({ description: 'Same value as contentType.' }) mimeType!: string;
  @ApiProperty({
    enum: DOCUMENT_AVAILABILITY,
    description:
      'AVAILABLE = uploaded and confirmed, a link can be issued. NOT_UPLOADED = the worker never confirmed the upload. DISCARDED = the server deleted the object (failed validation or abandoned).',
  })
  availability!: DocumentAvailability;
  @ApiProperty({ description: 'availability === AVAILABLE. A link can be issued.' })
  available!: boolean;
  @ApiProperty({
    description:
      'true = part of the worker submission and its file is available: show it to the reviewer. false for drafts that were never submitted, unconfirmed uploads and discarded files.',
  })
  reviewable!: boolean;
}

export class NoteView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['CALL', 'REVIEW'] }) kind!: 'CALL' | 'REVIEW';
  @ApiProperty() body!: string;
  @ApiProperty() authorUserId!: string;
  @ApiProperty() createdAt!: Date;
}

export class AdminCheckView extends CheckView {
  @ApiProperty({
    type: [NoteView],
    description: 'Reviewer and call notes, oldest first. Staff only.',
  })
  notes!: NoteView[];
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'Last reviewer action on the claim; a claim idle for 30 minutes is released automatically.',
  })
  lastActivityAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) dueAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) claimDueAt!: Date | null;
  @ApiProperty({ enum: ['OVERDUE', 'STALLED_CLAIM'], isArray: true }) slaFlags!: SlaFlag[];
  @ApiProperty({ nullable: true, type: Date }) decidedAt!: Date | null;
  @ApiProperty({ type: [AdminDocumentView] }) declare documents: AdminDocumentView[];
  @ApiProperty() checkId!: string;
  @ApiProperty({ nullable: true, type: String }) reviewerUserId!: string | null;
  @ApiProperty({ nullable: true, type: Date }) claimedAt!: Date | null;
  @ApiProperty({ type: [EventView], description: 'Full history, oldest first.' })
  history!: EventView[];
}

export class AdminWorkerVerificationResponse {
  @ApiProperty() workerId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'SEVA00000042' }) applicationReference!:
    string | null;
  @ApiProperty({ enum: APPLICATION_STATUSES }) applicationStatus!: ApplicationStatus;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Final sign-off time (verification.signoff).',
  })
  signedOffAt!: Date | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Activation time (worker.activate); live in search and matching.',
  })
  activatedAt!: Date | null;
  @ApiProperty({ enum: ['VERIFIED', 'IN_PROGRESS', 'NOT_STARTED'] }) level!: VerificationLevel;
  @ApiProperty({ enum: CHECK_TYPES, isArray: true }) requiredChecks!: CheckType[];
  @ApiProperty({ type: [AdminCheckView] }) checks!: AdminCheckView[];
}

export class DocumentLinkResponse {
  @ApiProperty({ description: 'Short-lived signed URL. Do not log or share it.' }) url!: string;
  @ApiProperty({ description: 'Same value as url (the name the admin web app asks for).' })
  signedUrl!: string;
  @ApiProperty({
    example: 'application/pdf',
    description: 'Validated content type of the stored file.',
  })
  mimeType!: string;
  @ApiProperty({ description: 'ISO-8601 instant at which the link stops working.' })
  expiresAt!: Date;
  @ApiProperty({
    description: 'Seconds from now until expiresAt, computed when the link was issued.',
  })
  expiresInSeconds!: number;
}

export class RequirementsResponse {
  @ApiProperty({ enum: CHECK_TYPES, isArray: true }) checkTypes!: CheckType[];
}
