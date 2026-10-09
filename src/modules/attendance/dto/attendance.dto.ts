import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** FRD FM-09: present, absent, exception ("configurable" - kept as a fixed set until the client defines more, Q-53). */
export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'EXCEPTION'] as const;
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

/** The same record for worker and customer (FRD FM-09: "customer and worker see the same recorded status"). */
export class AttendanceView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ example: '2026-11-03' }) date!: string;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) status!: AttendanceStatusValue;
  @ApiProperty({ nullable: true }) note!: string | null;
  @ApiProperty({ enum: ['WORKER', 'CUSTOMER', 'ADMIN'] }) recordedBy!: ActorKindValue;
  @ApiProperty() updatedAt!: Date;
}

export class AttendanceHistoryEntry {
  @ApiProperty({ nullable: true, enum: ATTENDANCE_STATUSES }) from!: AttendanceStatusValue | null;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) to!: AttendanceStatusValue;
  @ApiProperty({ nullable: true }) note!: string | null;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty() actorUserId!: string;
  @ApiProperty({ enum: ['WORKER', 'CUSTOMER', 'ADMIN'] }) actorKind!: ActorKindValue;
  @ApiProperty() at!: Date;
}

export class AdminAttendanceView extends AttendanceView {
  @ApiProperty() workerId!: string;
  @ApiProperty() recordedByUserId!: string;
  @ApiProperty({ type: [AttendanceHistoryEntry] }) history!: AttendanceHistoryEntry[];
}
