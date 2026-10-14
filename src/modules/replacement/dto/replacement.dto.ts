import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
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

export class CreateReplacementDto {
  @ApiProperty({ description: 'My ACTIVE booking.' })
  @IsUUID()
  bookingId!: string;

  @ApiProperty({
    maxLength: 1000,
    description:
      'Why a replacement is wanted (FR-REP-003). The specs define no reason list (Q-54).',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Supporting notes.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  notes?: string;
}

export class DecisionDto {
  @ApiPropertyOptional({ maxLength: 1000, description: 'Required when rejecting.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  remarks?: string;
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
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ nullable: true, description: 'Staff remarks on the decision.', type: String })
  decisionRemarks!: string | null;
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
    description: 'Staff remarks, on the APPROVED / REJECTED entry only.',
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
