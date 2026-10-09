import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { TIME_OF_DAY } from '../../availability/domain/time-windows';
import { ENGAGEMENTS, type Engagement } from '../../search/search.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** FRD section 4 (PROPOSED, Q-05). */
export const BOOKING_STATUSES = [
  'NEW_REQUEST',
  'MATCHED',
  'INTERVIEW_TRIAL_SCHEDULED',
  'INTERVIEW_TRIAL_COMPLETED',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'ACTIVE',
  'REPLACEMENT_REQUESTED',
  'REPLACED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type BookingStatusValue = (typeof BOOKING_STATUSES)[number];

export const SCHEDULE_TYPES = ['INTERVIEW', 'TRIAL'] as const;
export type ScheduleTypeValue = (typeof SCHEDULE_TYPES)[number];

/** Actions a party can perform. Each maps to one permitted transition of the state model. */
export const BOOKING_ACTIONS = [
  'match',
  'schedule',
  'decline',
  'reopen-matching',
  'interview-complete',
  'confirm-worker',
  'start',
  'complete',
  'cancel',
] as const;
export type BookingAction = (typeof BOOKING_ACTIONS)[number];

export class CreateBookingDto {
  @ApiProperty({ example: 'HOUSE_MAID', description: 'Category code; only enabled categories.' })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  category!: string;

  @ApiProperty({ description: 'Service area of the job; only enabled areas.' })
  @IsUUID()
  areaId!: string;

  @ApiProperty({ enum: ENGAGEMENTS })
  @IsIn(ENGAGEMENTS)
  engagement!: Engagement;

  @ApiProperty({ example: '09:00' })
  @Matches(TIME_OF_DAY, { message: 'availableFrom must be HH:mm' })
  availableFrom!: string;

  @ApiProperty({ example: '13:00' })
  @Matches(TIME_OF_DAY, { message: 'availableTo must be HH:mm' })
  availableTo!: string;

  @ApiPropertyOptional({
    description:
      'A worker reference from search. The worker must be eligible; the booking then starts as MATCHED. Without it the booking starts as NEW_REQUEST and staff match a worker.',
  })
  @IsOptional()
  @IsUUID()
  workerId?: string;
}

/** One body for every action; the action decides which fields are required (400 otherwise). Unknown fields are rejected. */
export class BookingActionDto {
  @ApiPropertyOptional({ description: 'match: the worker to assign.' })
  @IsOptional()
  @IsUUID()
  workerId?: string;

  @ApiPropertyOptional({ enum: SCHEDULE_TYPES, description: 'schedule: interview or trial.' })
  @IsOptional()
  @IsEnum(SCHEDULE_TYPES)
  scheduleType?: ScheduleTypeValue;

  @ApiPropertyOptional({ description: 'schedule: a future date and time (ISO 8601).' })
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledAt?: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'interview-complete: the recorded outcome.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  outcomeNote?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'confirm-worker: start date, today or later (India date).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must be a date in YYYY-MM-DD form' })
  startDate?: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'cancel: the reason (required).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  reason?: string;
}

export class BookingListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: BOOKING_STATUSES })
  @IsOptional()
  @IsEnum(BOOKING_STATUSES)
  status?: BookingStatusValue;
}

export class AdminBookingListQuery extends BookingListQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  workerId?: string;
}

export class CategoryRefView {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class AreaRefView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() city!: string;
}

export class TimelineEntry {
  @ApiProperty({ nullable: true, enum: BOOKING_STATUSES }) from!: BookingStatusValue | null;
  @ApiProperty({ enum: BOOKING_STATUSES }) to!: BookingStatusValue;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKER', 'ADMIN', 'SYSTEM'] }) by!: string;
  @ApiProperty({ nullable: true }) note!: string | null;
  @ApiProperty() at!: Date;
  @ApiPropertyOptional({ nullable: true, description: 'Administrator view only.' })
  actorUserId?: string | null;
}

export class BookingView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: BOOKING_STATUSES }) status!: BookingStatusValue;
  @ApiProperty({ type: CategoryRefView }) category!: CategoryRefView;
  @ApiProperty({ type: AreaRefView }) area!: AreaRefView;
  @ApiProperty({ enum: ENGAGEMENTS }) engagement!: Engagement;
  @ApiProperty({ example: '09:00' }) availableFrom!: string;
  @ApiProperty({ example: '13:00' }) availableTo!: string;
  @ApiProperty({ nullable: true, description: 'Opaque worker reference once a worker is matched.' })
  workerId!: string | null;
  @ApiProperty({ nullable: true, enum: SCHEDULE_TYPES }) scheduleType!: ScheduleTypeValue | null;
  @ApiProperty({ nullable: true }) scheduledAt!: Date | null;
  @ApiProperty({ nullable: true }) outcomeNote!: string | null;
  @ApiProperty({ nullable: true, example: '2026-11-01' }) startDate!: string | null;
  @ApiProperty({ nullable: true }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, description: 'The booking this one replaces, if any.' })
  replacesBookingId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class BookingDetailView extends BookingView {
  @ApiProperty({ type: [TimelineEntry], description: 'Status timeline, oldest first (FR-BK-007).' })
  timeline!: TimelineEntry[];
}

/** What a worker sees: the requirement summary only, never the customer (FRD FM-08). */
export class WorkerBookingView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: BOOKING_STATUSES }) status!: BookingStatusValue;
  @ApiProperty({ type: CategoryRefView }) category!: CategoryRefView;
  @ApiProperty({ type: AreaRefView }) area!: AreaRefView;
  @ApiProperty({ enum: ENGAGEMENTS }) engagement!: Engagement;
  @ApiProperty() availableFrom!: string;
  @ApiProperty() availableTo!: string;
  @ApiProperty({ nullable: true, enum: SCHEDULE_TYPES }) scheduleType!: ScheduleTypeValue | null;
  @ApiProperty({ nullable: true }) scheduledAt!: Date | null;
  @ApiProperty({ nullable: true, example: '2026-11-01' }) startDate!: string | null;
  @ApiProperty() updatedAt!: Date;
}

export class AdminBookingView extends BookingDetailView {
  @ApiProperty() customerUserId!: string;
  @ApiProperty({ nullable: true }) cancelledByUserId!: string | null;
}
