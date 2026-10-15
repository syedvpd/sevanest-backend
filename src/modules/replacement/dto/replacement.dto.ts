import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const REPLACEMENT_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'COMPLETED',
] as const;
export type ReplacementStatusValue = (typeof REPLACEMENT_STATUSES)[number];

export const REPLACEMENT_REASONS = [
  { code: 'WORK_QUALITY', label: 'Quality of work' },
  { code: 'BEHAVIOUR', label: 'Behaviour' },
  { code: 'ATTENDANCE', label: 'Attendance or punctuality' },
  { code: 'MISMATCH', label: 'Not the right match' },
  { code: 'WORKER_UNAVAILABLE', label: 'Worker unavailable' },
  { code: 'OTHER', label: 'Other' },
] as const;
export const REPLACEMENT_REASON_CODES = REPLACEMENT_REASONS.map((r) => r.code);
export type ReplacementReasonCode = (typeof REPLACEMENT_REASONS)[number]['code'];

export class CreateReplacementDto {
  @ApiProperty({ description: 'My ACTIVE booking.' })
  @IsUUID()
  bookingId!: string;

  @ApiPropertyOptional({
    enum: REPLACEMENT_REASON_CODES,
    description:
      'Fixed reason (Q-107); labels in GET /reference-data replacementReasons. Optional only for older clients: when omitted, "reason" is required and the code is OTHER.',
  })
  @IsOptional()
  @IsIn(REPLACEMENT_REASON_CODES)
  reasonCode?: ReplacementReasonCode;

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'Free-text detail. Required when reasonCode is omitted or OTHER; otherwise defaults to the reason label.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  reason?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Supporting notes.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  notes?: string;

  @ApiPropertyOptional({
    example: '2026-11-03',
    description:
      'Date the customer wants the replacement from (YYYY-MM-DD, a real date, today or later in India). Informational only: it does not change the replacement booking, its start date, price or the review time. 400 otherwise.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'neededFrom must be a date in YYYY-MM-DD form' })
  neededFrom?: string;
}

export class DecisionDto {
  @ApiPropertyOptional({ maxLength: 1000, description: 'Required when rejecting.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  remarks?: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'Customer-facing decision message (Q-110). Shown to the customer as written; "remarks" stay internal.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  message?: string;
}

export class SelectReplacementWorkerDto {
  @ApiProperty({
    description: 'The replacement worker (a worker reference from search or matching).',
  })
  @IsUUID()
  workerId!: string;
}

export class ReplacementListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: REPLACEMENT_STATUSES })
  @IsOptional()
  @IsEnum(REPLACEMENT_STATUSES)
  status?: ReplacementStatusValue;

  @ApiPropertyOptional({ description: 'Only the requests made for this booking.' })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class AdminReplacementListQuery extends ReplacementListQuery {}

export class ReplacementView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ enum: REPLACEMENT_STATUSES }) status!: ReplacementStatusValue;
  @ApiProperty({ enum: REPLACEMENT_REASON_CODES }) reasonCode!: ReplacementReasonCode;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({
    nullable: true,
    example: '2026-11-03',
    description: 'The date the customer asked for (informational), YYYY-MM-DD.',
    type: String,
  })
  neededFrom!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'Customer-facing decision message written by staff (Q-110).',
    type: String,
  })
  decisionMessage!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'The new booking once a replacement worker is confirmed.',
    type: String,
  })
  replacementBookingId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) decidedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}

export class AdminReplacementView extends ReplacementView {
  @ApiProperty() requestedByUserId!: string;
  @ApiProperty({ nullable: true, type: String }) decidedByUserId!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'Internal staff remarks: never returned to customers (Q-110).',
    type: String,
  })
  decisionRemarks!: string | null;
  @ApiProperty({ nullable: true, description: 'The worker being replaced.', type: String })
  currentWorkerId!: string | null;
}

export class ReplacementTimelineEntry {
  @ApiProperty({ enum: REPLACEMENT_STATUSES, description: 'The status the request moved to.' })
  status!: ReplacementStatusValue;
  @ApiProperty() at!: Date;
  @ApiProperty({
    enum: ['CUSTOMER', 'STAFF', 'SYSTEM'],
    description: 'SYSTEM = closed because the booking itself was cancelled.',
  })
  actor!: 'CUSTOMER' | 'STAFF' | 'SYSTEM';
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Customer-facing decision message, on the APPROVED / REJECTED entry only.',
  })
  remarks!: string | null;
}

export class ReplacementDetailView extends ReplacementView {
  @ApiProperty({
    type: [ReplacementTimelineEntry],
    description:
      'Persisted status history, oldest first. There is no review ETA: no review-time rule is defined (Q-107).',
  })
  timeline!: ReplacementTimelineEntry[];
}
