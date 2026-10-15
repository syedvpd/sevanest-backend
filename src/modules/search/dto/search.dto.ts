import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { LANGUAGE_CODE } from '../../../common/validation/language';
import { TIME_OF_DAY } from '../../availability/domain/time-windows';
import { ENGAGEMENTS, type Engagement } from '../search.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SearchWorkersQuery extends PageQueryDto {
  @ApiProperty({ example: 'HOUSE_MAID', description: 'Category code; only enabled categories.' })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  category!: string;

  @ApiProperty({ description: 'The service area of the job; only enabled areas.' })
  @IsUUID()
  areaId!: string;

  @ApiPropertyOptional({ enum: ENGAGEMENTS })
  @IsOptional()
  @IsIn(ENGAGEMENTS)
  engagement?: Engagement;

  @ApiPropertyOptional({
    example: '09:00',
    description:
      'With availableTo: a worker matches when one availability window covers the whole range.',
  })
  @IsOptional()
  @Matches(TIME_OF_DAY, { message: 'availableFrom must be HH:mm' })
  availableFrom?: string;

  @ApiPropertyOptional({ example: '13:00' })
  @IsOptional()
  @Matches(TIME_OF_DAY, { message: 'availableTo must be HH:mm' })
  availableTo?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'The date the work starts (India). With the timings, workers already booked for an overlapping time on those dates are left out. Defaults to today.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({ example: 'hi' })
  @IsOptional()
  @Matches(LANGUAGE_CODE, { message: 'language must be a language code such as "hi"' })
  language?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1200)
  minExperienceMonths?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10,
    description:
      'Only workers whose average rating is at least this (workers with no rating are excluded). Must not exceed `ratingScaleMax` from GET /reference-data (400 otherwise).',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(10)
  minRating?: number;

  @ApiPropertyOptional({
    enum: ['EXPERIENCE_DESC', 'EXPERIENCE_ASC', 'RATING_DESC'],
    default: 'EXPERIENCE_DESC',
    description:
      'A stable ordering by the stated attribute, not a relevance ranking (none is defined). Unknown values are rejected (400).',
  })
  @IsOptional()
  @IsIn(['EXPERIENCE_DESC', 'EXPERIENCE_ASC', 'RATING_DESC'])
  sort: 'EXPERIENCE_DESC' | 'EXPERIENCE_ASC' | 'RATING_DESC' = 'EXPERIENCE_DESC';
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

export class AvailabilityWindowView {
  @ApiProperty({ example: '09:00' }) start!: string;
  @ApiProperty({ example: '13:00' }) end!: string;
}

export class RatingSummaryView {
  @ApiProperty({ description: 'Mean score, two decimals.' }) average!: number;
  @ApiProperty() count!: number;
}

export class PhotoLinkView {
  @ApiProperty({
    description:
      'Short-lived link to the small square WebP (320 px) for cards and lists. Do not store the link; cache the image by `cacheKey`.',
  })
  url!: string;
  @ApiProperty({
    description:
      'Short-lived link to the large WebP (longest side at most 1080 px) for the profile screen.',
  })
  largeUrl!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({
    description:
      'Stable while the photo is unchanged: use it as the image cache key, because the signed links change on every read.',
  })
  cacheKey!: string;
}

/**
 * The worker card (FR-WD-001): experience, skills, language, area, availability and the verification badge. It carries no
 * name, contact detail, address, emergency contact, salary, document or internal identifier of the account (FR-WD-007).
 * The photo is a short-lived signed link (null when the worker has none) and the rating is the aggregate only (null until the
 * first rating): no reviewer, no review text.
 */
export class WorkerCard {
  @ApiProperty({ description: 'Opaque worker reference for the next step (not the account id).' })
  workerId!: string;
  @ApiProperty({ nullable: true, description: 'Total months.', type: Number }) experienceMonths!:
    number | null;
  @ApiProperty({ type: [CategoryRefView] }) categories!: CategoryRefView[];
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: [AreaRefView] }) serviceAreas!: AreaRefView[];
  @ApiProperty({ enum: ENGAGEMENTS, nullable: true }) engagementPreference!: Engagement | null;
  @ApiProperty({ type: [AvailabilityWindowView] }) availability!: AvailabilityWindowView[];
  @ApiProperty({
    enum: ['VERIFIED'],
    description: 'Customers only ever see fully verified workers.',
  })
  verification!: 'VERIFIED';
  @ApiProperty({ type: RatingSummaryView, nullable: true }) rating!: RatingSummaryView | null;
  @ApiProperty({ type: PhotoLinkView, nullable: true }) photo!: PhotoLinkView | null;
}

export class WorkerReviewView {
  @ApiProperty({
    description: '1 to the rating scale maximum (see GET /reference-data ratingScaleMax).',
  })
  score!: number;
  @ApiProperty({
    nullable: true,
    description: 'The review text, or null when the customer gave a score only.',
    type: String,
  })
  comment!: string | null;
  @ApiProperty({
    type: [String],
    description: 'Tag codes the customer chose (GET /reference-data ratingTags); empty when none.',
  })
  tags!: string[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty({
    nullable: true,
    description:
      'First word of the reviewer name only. No surname, id, contact or booking reference.',
    type: String,
  })
  reviewerFirstName!: string | null;
}

export class SlotsQuery {
  @ApiProperty({
    example: '2026-11-03',
    description: 'India date, from today up to the booking horizon.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;
}

export class WorkerSlotsView {
  @ApiProperty() date!: string;
  @ApiProperty({ example: 60, description: 'Length of one interview or trial slot in minutes.' })
  slotMinutes!: number;
  @ApiProperty({
    example: 14,
    description: 'How many days ahead a slot can be requested (today included).',
  })
  horizonDays!: number;
  @ApiProperty({
    type: [String],
    example: ['09:00', '10:00'],
    description: 'Free start times (HH:mm, India time), earliest first.',
  })
  slots!: string[];
}
