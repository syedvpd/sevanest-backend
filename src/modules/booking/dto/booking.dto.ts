import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { TIME_OF_DAY } from '../../availability/domain/time-windows';
import { ENGAGEMENTS, type Engagement } from '../../search/search.types';
import { PhotoLinkView } from '../../search/dto/search.dto';
import {
  RATING_ELIGIBILITY_CODES,
  type RatingEligibilityCode,
} from '../../../common/rating/rating-eligibility';

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

/** Short, plain labels for the apps (PRD 6: simple status labels). The enum values are the stable contract; wording and translations are content. */
export const BOOKING_STATUS_LABELS: Record<BookingStatusValue, string> = {
  NEW_REQUEST: 'Request received',
  MATCHED: 'Worker matched',
  INTERVIEW_TRIAL_SCHEDULED: 'Interview scheduled',
  INTERVIEW_TRIAL_COMPLETED: 'Interview done',
  PENDING_PAYMENT: 'Payment due',
  CONFIRMED: 'Confirmed',
  ACTIVE: 'In service',
  REPLACEMENT_REQUESTED: 'Replacement requested',
  REPLACED: 'Replaced',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

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
  'accept',
] as const;
export type BookingAction = (typeof BOOKING_ACTIONS)[number];

export const BUDGET_PERIODS = ['HOUR', 'DAY', 'MONTH', 'ONE_TIME'] as const;

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

  @ApiPropertyOptional({
    description:
      "One of my saved addresses (404 if it is not mine or was removed; 422 OUTSIDE_SERVICE_AREA if its city is not the area's city). Only staff see it; the worker never does.",
  })
  @IsOptional()
  @IsUUID()
  addressId?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'When the service should begin; today or later (India date).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must be a date in YYYY-MM-DD form' })
  startDate?: string;

  @ApiPropertyOptional({ description: 'Smallest currency unit (paise).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  budgetMinMinor?: number;

  @ApiPropertyOptional({ description: 'Smallest currency unit (paise); not below budgetMinMinor.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  budgetMaxMinor?: number;

  @ApiPropertyOptional({
    enum: BUDGET_PERIODS,
    description:
      'What the budget is per. A label only: matching does not compare budgets (Q-39). A "monthly driver/cook" (DEC-07) is FULL_TIME or PART_TIME with budgetPeriod MONTH; MONTHLY is accepted as an alias and stored as MONTH.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'MONTHLY' ? 'MONTH' : value))
  @IsIn(BUDGET_PERIODS)
  budgetPeriod?: (typeof BUDGET_PERIODS)[number];

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Free-text requirement for the worker (no HTML).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  @Matches(/^[^<>]*$/, { message: 'requirementNote must not contain < or >' })
  requirementNote?: string;
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

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'cancel: the reason (required). decline: the reason (recommended).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  reason?: string;
}

/** Staff creating a booking on behalf of a customer (phone-in request): the same fields as the customer's own request. */
export class AdminCreateBookingDto extends CreateBookingDto {
  @ApiProperty({
    description: 'The customer (customer profile id, as listed under /admin/customers).',
  })
  @IsUUID()
  customerId!: string;
}

export class BookingListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: BOOKING_STATUSES })
  @IsOptional()
  @IsEnum(BOOKING_STATUSES)
  status?: BookingStatusValue;
}

export class BookingFilterQuery extends BookingListQuery {
  @ApiPropertyOptional({ description: 'Service category id.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Service area id.' })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiPropertyOptional({ enum: ENGAGEMENTS })
  @IsOptional()
  @IsIn(ENGAGEMENTS)
  engagement?: Engagement;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Requested on or after (India date).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'createdFrom must be YYYY-MM-DD' })
  createdFrom?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Requested on or before (India date).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'createdTo must be YYYY-MM-DD' })
  createdTo?: string;
}

export class AdminBookingListQuery extends BookingFilterQuery {
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
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() at!: Date;
  @ApiPropertyOptional({ nullable: true, description: 'Administrator view only.', type: String })
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
  @ApiProperty({
    nullable: true,
    description: 'Opaque worker reference once a worker is matched.',
    type: String,
  })
  workerId!: string | null;
  @ApiProperty({ nullable: true, enum: SCHEDULE_TYPES }) scheduleType!: ScheduleTypeValue | null;
  @ApiProperty({ nullable: true, type: Date }) scheduledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) outcomeNote!: string | null;
  @ApiProperty({ nullable: true, example: '2026-11-01', type: String }) startDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'The booking this one replaces, if any.',
    type: String,
  })
  replacesBookingId!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'The saved address of the job (customer and staff only).',
    type: String,
  })
  addressId!: string | null;
  @ApiProperty({
    nullable: true,
    example: '2026-11-01',
    description: 'When the customer asked the service to begin.',
    type: String,
  })
  requestedStartDate!: string | null;
  @ApiProperty({ nullable: true, type: Number }) budgetMinMinor!: number | null;
  @ApiProperty({ nullable: true, type: Number }) budgetMaxMinor!: number | null;
  @ApiProperty({ nullable: true, enum: BUDGET_PERIODS }) budgetPeriod!: string | null;
  @ApiProperty({ nullable: true, type: String }) requirementNote!: string | null;
  @ApiProperty({ nullable: true, description: 'When the matched worker accepted.', type: Date })
  workerRespondedAt!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'Deadline for the worker to respond, if one is configured.',
    type: Date,
  })
  respondBy!: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'A different interview/trial time the worker proposed; waits for the customer.',
    type: Date,
  })
  proposedSlotAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) proposedSlotNote!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class ProposeSlotDto {
  @ApiProperty({ example: '2026-11-03T10:00:00.000Z', description: 'ISO 8601, in the future.' })
  @IsISO8601()
  proposedAt!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  note?: string;
}

/** One booking of a replacement chain. */
export class ChainEntryView {
  @ApiProperty() bookingId!: string;
  @ApiProperty({ description: '1 = the original booking.' }) position!: number;
  @ApiProperty({ enum: BOOKING_STATUSES }) status!: BookingStatusValue;
  @ApiProperty({ nullable: true, type: String }) replacesBookingId!: string | null;
  @ApiProperty({ nullable: true, example: '2026-11-01', type: String }) startDate!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ description: 'The booking the caller asked about.' }) current!: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'Administrator view only.', type: String })
  workerId?: string | null;
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
  @ApiProperty({ nullable: true, type: Date }) scheduledAt!: Date | null;
  @ApiProperty({ nullable: true, example: '2026-11-01', type: String }) startDate!: string | null;
  @ApiProperty({ nullable: true, example: '2026-11-01', type: String }) requestedStartDate!:
    string | null;
  @ApiProperty({ nullable: true, type: Number }) budgetMinMinor!: number | null;
  @ApiProperty({ nullable: true, type: Number }) budgetMaxMinor!: number | null;
  @ApiProperty({ nullable: true, enum: BUDGET_PERIODS }) budgetPeriod!: string | null;
  @ApiProperty({ nullable: true, type: String }) requirementNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) workerRespondedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) respondBy!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) proposedSlotAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) proposedSlotNote!: string | null;
  @ApiProperty() updatedAt!: Date;
}

export class AdminBookingView extends BookingDetailView {
  @ApiProperty() customerUserId!: string;
  @ApiProperty({ nullable: true, type: String }) cancelledByUserId!: string | null;
}

/**
 * Actions the customer may take on a booking RIGHT NOW (stable codes, D-79). The state-machine ones are the POST /bookings/{id}/{action}
 * routes; `pay` = POST /payments, `rate` = POST /ratings, `rebook` = POST /bookings/{id}/rebook, `report-attendance-exception` =
 * POST /attendance/bookings/{id}/exceptions. The server re-checks every one of them when it is used.
 */
export const CUSTOMER_ALLOWED_ACTIONS = [
  'schedule',
  'reopen-matching',
  'interview-complete',
  'confirm-worker',
  'start',
  'complete',
  'cancel',
  'pay',
  'rate',
  'rebook',
  'report-attendance-exception',
] as const;
export type CustomerAllowedAction = (typeof CUSTOMER_ALLOWED_ACTIONS)[number];

/** Who served (or will serve) the customer, without anything private: no phone, address, documents or storage key (D-81). */
export class WorkerDisplayView {
  @ApiProperty({ example: 'Ramesh K.', description: 'First name and last initial.' })
  displayName!: string;
  @ApiProperty({
    example: 'Ramesh K.',
    description: 'Same value as displayName (alias for clients that read `name`).',
  })
  name!: string;
  @ApiProperty({
    example: true,
    description:
      'true while the worker is fully verified, active and submitted (the rule that decides who customers can see); false when that no longer holds. Never assumed.',
  })
  verified!: boolean;
  @ApiProperty({ example: 'RK', description: 'Fallback for the avatar when there is no photo.' })
  initials!: string;
  @ApiProperty({
    type: PhotoLinkView,
    nullable: true,
    description:
      'Short-lived links to the current profile photo (small and large WebP); null when the worker has none or storage is unavailable. Cache by photo.cacheKey.',
  })
  photo!: PhotoLinkView | null;
}

export class BookingRatingView {
  @ApiProperty({ description: 'This booking already has my rating.' }) rated!: boolean;
  @ApiProperty({ description: 'POST /ratings would be accepted right now.' }) eligible!: boolean;
  @ApiProperty({ enum: RATING_ELIGIBILITY_CODES }) code!: RatingEligibilityCode;
}

/** What the customer's own booking responses add to the common view. */
export class CustomerBookingView extends BookingView {
  @ApiProperty({
    type: WorkerDisplayView,
    nullable: true,
    description:
      'The worker, once the customer has reached the interview stage with them (INTERVIEW_TRIAL_SCHEDULED or later; never for a CANCELLED or earlier booking). null otherwise.',
  })
  worker!: WorkerDisplayView | null;
  @ApiProperty({ enum: CUSTOMER_ALLOWED_ACTIONS, isArray: true })
  allowedActions!: CustomerAllowedAction[];
  @ApiProperty({ type: BookingRatingView }) rating!: BookingRatingView;
}

export class CustomerBookingDetailView extends CustomerBookingView {
  @ApiProperty({ type: [TimelineEntry], description: 'Status timeline, oldest first (FR-BK-007).' })
  timeline!: TimelineEntry[];
}

export const HISTORY_STATUSES = ['COMPLETED', 'REPLACED', 'CANCELLED'] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export class BookingHistoryQuery extends PageQueryDto {
  @ApiPropertyOptional({
    example: 2026,
    description:
      'Year of the service: its start date, or the request date when it never started (India time).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ example: 'HOUSE_MAID', description: 'Service category code.' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/, { message: 'category must be a category code' })
  category?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Matches the category name, or the worker name for bookings where the worker is shown. Case-insensitive, plain text (no wildcards).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  search?: string;

  @ApiPropertyOptional({
    enum: HISTORY_STATUSES,
    description: 'Default: all three (completed, ended early, cancelled).',
  })
  @IsOptional()
  @IsIn(HISTORY_STATUSES)
  status?: HistoryStatus;
}

export class BookingHistorySummaryQuery {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ example: 'HOUSE_MAID' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/, { message: 'category must be a category code' })
  category?: string;
}

export class BookingHistoryItemView extends CustomerBookingView {
  @ApiProperty({
    description:
      'Money for this booking that is still with the platform (successful payments and refunds not yet returned), in paise.',
  })
  amountPaidMinor!: number;
  @ApiProperty({ example: 'INR' }) currency!: string;
}

export class BookingHistorySummaryView {
  @ApiProperty({
    description: 'Bookings that were delivered: COMPLETED or REPLACED (ended early).',
  })
  totalServices!: number;
  @ApiProperty({ description: 'Different workers across those bookings.' })
  distinctWorkers!: number;
  @ApiProperty({
    description:
      'Paise the customer paid across ALL bookings matching the filters (including cancelled ones whose money was not refunded). Refunded money is not counted.',
  })
  totalSpentMinor!: number;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ nullable: true, type: Number }) year!: number | null;
  @ApiProperty({ nullable: true, type: String }) category!: string | null;
}

export class RebookDto {
  @ApiProperty({ description: 'My COMPLETED booking whose worker I want to hire again.' })
  @IsUUID()
  bookingId!: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'When the new service should begin (India date, today or later). Omit to leave it open.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;
}
