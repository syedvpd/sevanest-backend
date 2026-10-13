import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const INTERVIEW_TYPES = ['INTERVIEW', 'TRIAL'] as const;
export type InterviewTypeValue = (typeof INTERVIEW_TYPES)[number];

/**
 * REQUESTED = the customer asked for a time and waits for the worker; CONFIRMED = a time is agreed; RESCHEDULE_PROPOSED = the other party
 * proposed a different time and waits for an answer; DECLINED = the worker declined the request; CANCELLED; COMPLETED = it took place and
 * an outcome was recorded. At most one session of a booking is open (REQUESTED, CONFIRMED or RESCHEDULE_PROPOSED) at a time.
 */
export const INTERVIEW_STATUSES = [
  'REQUESTED',
  'CONFIRMED',
  'RESCHEDULE_PROPOSED',
  'DECLINED',
  'CANCELLED',
  'COMPLETED',
] as const;
export type InterviewStatusValue = (typeof INTERVIEW_STATUSES)[number];

/** Short labels for the apps (PRD 6: simple status labels). Wording is a default; localisation is content the client supplies. */
export const INTERVIEW_STATUS_LABELS: Record<InterviewStatusValue, string> = {
  REQUESTED: 'Waiting for worker',
  CONFIRMED: 'Confirmed',
  RESCHEDULE_PROPOSED: 'New time proposed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
  COMPLETED: 'Done',
};

export class RequestInterviewDto {
  @ApiProperty({
    description: 'The booking (with a matched worker) the interview or trial is for.',
  })
  @IsUUID()
  bookingId!: string;

  @ApiProperty({ enum: INTERVIEW_TYPES })
  @IsIn(INTERVIEW_TYPES)
  type!: InterviewTypeValue;

  @ApiProperty({
    example: '2026-11-03T10:00:00.000Z',
    description: 'The preferred time, ISO 8601, in the future.',
  })
  @IsISO8601()
  preferredAt!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  note?: string;
}

export class RescheduleInterviewDto {
  @ApiProperty({ example: '2026-11-04T10:00:00.000Z' })
  @IsISO8601()
  preferredAt!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  note?: string;
}

export class ProposeInterviewDto {
  @ApiProperty({
    example: '2026-11-04T12:00:00.000Z',
    description: 'A different time, ISO 8601, in the future.',
  })
  @IsISO8601()
  proposedAt!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  note?: string;
}

export class DeclineInterviewDto {
  @ApiProperty({ maxLength: 300 })
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  reason!: string;
}

export class CancelInterviewDto {
  @ApiProperty({ maxLength: 300 })
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  reason!: string;
}

export class CompleteInterviewDto {
  @ApiProperty({
    maxLength: 1000,
    description:
      'The outcome of the interview or trial (free text; outcome values are undecided, Q-55).',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  outcomeNote!: string;
}

export class InterviewListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: INTERVIEW_STATUSES })
  @IsOptional()
  @IsEnum(INTERVIEW_STATUSES)
  status?: InterviewStatusValue;

  @ApiPropertyOptional({ enum: INTERVIEW_TYPES })
  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  type?: InterviewTypeValue;
}

export class AdminInterviewListQuery extends InterviewListQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export const CUSTOMER_INTERVIEW_ACTIONS = [
  'reschedule',
  'cancel',
  'complete',
  'accept-proposal',
  'reject-proposal',
] as const;

export class InterviewTimelineEntry {
  @ApiProperty({ example: 'Requested' }) title!: string;
  @ApiProperty({ enum: ['done', 'current', 'upcoming', 'failed'] }) state!: string;
  @ApiProperty({ nullable: true, type: Date }) at!: Date | null;
}

export class InterviewView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ enum: INTERVIEW_TYPES }) type!: InterviewTypeValue;
  @ApiProperty({ enum: INTERVIEW_STATUSES }) status!: InterviewStatusValue;
  @ApiProperty({ description: 'Short label for the status.' }) statusLabel!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKER', 'ADMIN', 'SYSTEM'] }) requestedBy!: string;
  @ApiProperty() preferredAt!: Date;
  @ApiProperty({ nullable: true, description: 'The agreed time.', type: Date })
  scheduledAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'A different time proposed, waiting for an answer.',
    type: Date,
  })
  proposedAt!: Date | null;
  @ApiProperty({ nullable: true, enum: ['CUSTOMER', 'WORKER'] }) proposedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String }) declineReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) outcomeNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({
    enum: CUSTOMER_INTERVIEW_ACTIONS,
    isArray: true,
    description:
      'What the CUSTOMER may do now (POST /interviews/{id}/<action>). Empty once the session is closed. Staff and the worker use their own routes.',
  })
  allowedActions!: Array<(typeof CUSTOMER_INTERVIEW_ACTIONS)[number]>;
  @ApiProperty({
    type: [InterviewTimelineEntry],
    description: 'Derived from the recorded times, oldest first.',
  })
  timeline!: InterviewTimelineEntry[];
}
