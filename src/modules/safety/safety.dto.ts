import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** PROPOSED vocabulary: the PRD asks for report/block without listing reasons (Q-74). */
export const REPORT_REASONS = [
  'HARASSMENT',
  'THEFT',
  'SAFETY_CONCERN',
  'MISCONDUCT',
  'FRAUD',
  'NO_SHOW',
  'OTHER',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const NOTE = /^[^<>]*$/;

export class CreateBlockDto {
  @ApiPropertyOptional({
    description: 'Customers: the worker to block (a worker reference from search or a booking).',
  })
  @IsOptional()
  @IsUUID()
  workerId?: string;

  @ApiPropertyOptional({
    description:
      'Workers: block the customer of this booking (you must be its worker). Customers may use it instead of workerId.',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  @Matches(NOTE, { message: 'reason must not contain < or >' })
  reason?: string;
}

export class CreateReportDto extends CreateBlockDto {
  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reasonCode!: ReportReason;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  @Matches(NOTE, { message: 'note must not contain < or >' })
  note?: string;

  @ApiPropertyOptional({ default: false, description: 'Also block the other person.' })
  @IsOptional()
  @IsBoolean()
  alsoBlock?: boolean;
}

export class AdminCreateBlockDto {
  @ApiProperty() @IsUUID() blockerUserId!: string;
  @ApiProperty() @IsUUID() blockedUserId!: string;

  @ApiProperty({ maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  @Matches(NOTE, { message: 'reason must not contain < or >' })
  reason!: string;
}

export class AdminListQuery extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only reports about / blocks involving this user.' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class BlockView {
  @ApiProperty() id!: string;
  @ApiProperty({
    nullable: true,
    description: 'Customers see the worker reference they blocked; workers see none.',
  })
  workerId!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class ReportView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: REPORT_REASONS }) reasonCode!: string;
  @ApiProperty() createdAt!: Date;
}

export class AdminBlockView {
  @ApiProperty() id!: string;
  @ApiProperty() blockerUserId!: string;
  @ApiProperty() blockedUserId!: string;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty() createdByAdmin!: boolean;
  @ApiProperty() createdAt!: Date;
}

export class AdminReportView extends ReportView {
  @ApiProperty() reporterUserId!: string;
  @ApiProperty() targetUserId!: string;
  @ApiProperty({ nullable: true }) bookingId!: string | null;
  @ApiProperty({ nullable: true }) note!: string | null;
}
