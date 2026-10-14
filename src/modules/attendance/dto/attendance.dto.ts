import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { WorkerDisplayView } from '../../booking/dto/booking.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * FRD FM-09: present, absent, exception, "configurable". LATE (worked, arrived late) and LEAVE (announced leave, not a worked day)
 * were added for the customer app design (D-76); only a worker (today) or staff record them, a customer can only raise EXCEPTION.
 */
export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'EXCEPTION', 'LATE', 'LEAVE'] as const;
export type AttendanceStatusValue = (typeof ATTENDANCE_STATUSES)[number];
export type ActorKindValue = 'WORKER' | 'CUSTOMER' | 'ADMIN';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A worker records TODAY only; the date is not a field they can choose. */
export class RecordAttendanceDto {
  @ApiProperty({ enum: ATTENDANCE_STATUSES })
  @IsEnum(ATTENDANCE_STATUSES)
  status!: AttendanceStatusValue;

  @ApiPropertyOptional({ maxLength: 500, description: 'Required for EXCEPTION.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class AdminRecordAttendanceDto extends RecordAttendanceDto {
  @ApiProperty({
    example: '2026-11-03',
    description: 'India date, from the booking start date up to today.',
  })
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;
}

export class RaiseExceptionDto {
  @ApiProperty({
    example: '2026-11-03',
    description: 'India date, from the booking start date up to today.',
  })
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiProperty({ maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note!: string;
}

export class CorrectAttendanceDto {
  @ApiProperty({ enum: ATTENDANCE_STATUSES })
  @IsEnum(ATTENDANCE_STATUSES)
  status!: AttendanceStatusValue;

  @ApiPropertyOptional({ maxLength: 500, description: 'Required for EXCEPTION.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note?: string;

  @ApiProperty({
    maxLength: 500,
    description: 'Why the entry is being corrected (kept in the history).',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class AttendanceListQuery extends PageQueryDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

export class AttendanceSummaryQuery {
  @ApiProperty({ example: '2026-11', description: 'The calendar month, YYYY-MM.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;
}

/** Counts per status for one calendar month. Days with no entry are simply not counted (nothing is assumed absent). */
export class AttendanceSummaryView {
  @ApiProperty() bookingId!: string;
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ example: '2026-11-01' }) from!: string;
  @ApiProperty({ example: '2026-11-30' }) to!: string;
  @ApiProperty() daysInMonth!: number;
  @ApiProperty() present!: number;
  @ApiProperty() absent!: number;
  @ApiProperty() exception!: number;
  @ApiProperty({ description: 'Worked, arrived late.' }) late!: number;
  @ApiProperty({ description: 'Announced leave of the worker (not a worked day).' }) leave!: number;
  @ApiProperty({ description: 'present + absent + exception + late + leave' }) recorded!: number;
  @ApiProperty({
    type: () => ScheduledWindowView,
    nullable: true,
    description: "The booking's own time window (the customer's requested hours), never a default.",
  })
  scheduledWindow!: ScheduledWindowView | null;
  @ApiPropertyOptional({
    type: () => WorkerDisplayView,
    nullable: true,
    description:
      'Customer view only: the worker of the booking (display name and safe photo link).',
  })
  worker?: WorkerDisplayView | null;
}

export class ScheduledWindowView {
  @ApiProperty({ example: '08:00' }) from!: string;
  @ApiProperty({ example: '12:00' }) to!: string;
}

/** The same record for worker and customer (FRD FM-09: "customer and worker see the same recorded status"). */
export class AttendanceView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ example: '2026-11-03' }) date!: string;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) status!: AttendanceStatusValue;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'Stamped by the server when the worker checked in; null when nobody did (never inferred from the status).',
  })
  checkInAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'Stamped by the server at check-out.' })
  checkOutAt!: Date | null;
  @ApiProperty({ enum: ['WORKER', 'CUSTOMER', 'ADMIN'] }) recordedBy!: ActorKindValue;
  @ApiProperty() updatedAt!: Date;
}

export class AttendanceHistoryEntry {
  @ApiProperty({ nullable: true, enum: ATTENDANCE_STATUSES }) from!: AttendanceStatusValue | null;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) to!: AttendanceStatusValue;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty() actorUserId!: string;
  @ApiProperty({ enum: ['WORKER', 'CUSTOMER', 'ADMIN'] }) actorKind!: ActorKindValue;
  @ApiProperty() at!: Date;
}

export class AdminAttendanceView extends AttendanceView {
  @ApiProperty() workerId!: string;
  @ApiProperty() recordedByUserId!: string;
  @ApiProperty({ type: [AttendanceHistoryEntry] }) history!: AttendanceHistoryEntry[];
}
