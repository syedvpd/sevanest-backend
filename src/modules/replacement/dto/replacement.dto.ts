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
}

export class AdminReplacementListQuery extends ReplacementListQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class ReplacementView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ enum: REPLACEMENT_STATUSES }) status!: ReplacementStatusValue;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true, description: 'Staff remarks on the decision.' }) decisionRemarks!:
    string | null;
  @ApiProperty({
    nullable: true,
    description: 'The new booking once a replacement worker is confirmed.',
  })
  replacementBookingId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) decidedAt!: Date | null;
  @ApiProperty({ nullable: true }) completedAt!: Date | null;
}

export class AdminReplacementView extends ReplacementView {
  @ApiProperty() requestedByUserId!: string;
  @ApiProperty({ nullable: true }) decidedByUserId!: string | null;
  @ApiProperty({ nullable: true, description: 'The worker being replaced.' }) currentWorkerId!:
    string | null;
}
