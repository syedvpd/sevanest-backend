import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const RATING_STATUSES = ['VISIBLE', 'HIDDEN'] as const;
export type RatingStatusValue = (typeof RATING_STATUSES)[number];

/** Technical cap against abuse, not a product rule (FRD FM-10 asks for "a length limit" without a value, Q-58). */
export const REVIEW_MAX_LENGTH = 2000;

export class CreateRatingDto {
  @ApiProperty({
    description:
      'My COMPLETED booking. The worker is the booking worker; it is never supplied by the caller.',
  })
  @IsUUID()
  bookingId!: string;

  @ApiProperty({
    minimum: 1,
    description: 'Whole number from 1 to the configured top of the scale (RATING_SCALE_MAX).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  score!: number;

  @ApiPropertyOptional({ maxLength: REVIEW_MAX_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, REVIEW_MAX_LENGTH)
  review?: string;
}

export class ModerationDto {
  @ApiProperty({ maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  reason!: string;
}

export class RatingListQuery extends PageQueryDto {}

export class AdminRatingListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: RATING_STATUSES })
  @IsOptional()
  @IsEnum(RATING_STATUSES)
  status?: RatingStatusValue;

  @ApiPropertyOptional({ description: 'Worker reference.' })
  @IsOptional()
  @IsUUID()
  workerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

/** What the customer who wrote the rating sees. */
export class RatingView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty() score!: number;
  @ApiProperty({ nullable: true }) review!: string | null;
  @ApiProperty({
    enum: RATING_STATUSES,
    description: 'HIDDEN = removed from the worker profile by an administrator.',
  })
  status!: RatingStatusValue;
  @ApiProperty() createdAt!: Date;
}

/** What a worker sees about a rating they received: no customer identity, no booking (Q-60). */
export class WorkerRatingView {
  @ApiProperty() id!: string;
  @ApiProperty() score!: number;
  @ApiProperty({ nullable: true }) review!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class RatingSummaryView {
  @ApiProperty() count!: number;
  @ApiProperty({
    nullable: true,
    description: 'Mean of visible ratings, two decimals; null when there are none.',
  })
  average!: number | null;
  @ApiProperty({ description: 'Top of the configured scale.' }) scaleMax!: number;
}

export class AdminRatingView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty() workerId!: string;
  @ApiProperty() customerUserId!: string;
  @ApiProperty() score!: number;
  @ApiProperty({ nullable: true }) review!: string | null;
  @ApiProperty({ enum: RATING_STATUSES }) status!: RatingStatusValue;
  @ApiProperty({ nullable: true }) moderatedByUserId!: string | null;
  @ApiProperty({ nullable: true }) moderatedAt!: Date | null;
  @ApiProperty({ nullable: true }) moderationReason!: string | null;
  @ApiProperty() createdAt!: Date;
}
