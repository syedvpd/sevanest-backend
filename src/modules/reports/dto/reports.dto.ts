import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

export const REPORT_INTERVALS = ['day', 'week', 'month'] as const;
export type ReportInterval = (typeof REPORT_INTERVALS)[number];

/**
 * Technical guard: every report is bounded to this many calendar days so one request cannot scan the whole history.
 * It is not a product rule (the reporting periods are an open decision, Q-61).
 */
export const MAX_REPORT_RANGE_DAYS = 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ReportRangeQuery {
  @ApiProperty({ example: '2026-10-01', description: 'First day (India calendar), inclusive.' })
  @Matches(DATE, { message: 'from must be a date written as YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description: `Last day (India calendar), inclusive. At most ${MAX_REPORT_RANGE_DAYS} days from "from".`,
  })
  @Matches(DATE, { message: 'to must be a date written as YYYY-MM-DD' })
  to!: string;
}

export class ReportSeriesQuery extends ReportRangeQuery {
  @ApiPropertyOptional({
    enum: REPORT_INTERVALS,
    default: 'day',
    description: 'Bucket size. Weeks start on Monday (India calendar).',
  })
  @IsOptional()
  @IsEnum(REPORT_INTERVALS)
  interval: ReportInterval = 'day';
}

export class ReportPagedQuery extends ReportRangeQuery {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class TopRatedQuery extends PageQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description:
      'Only workers with at least this many visible ratings. No minimum is defined by the specs (Q-61).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minRatings: number = 1;
}

/** Envelope of every report: what was measured, how, over which period, and what the numbers cannot tell. */
export class ReportResponse<T = unknown> {
  @ApiProperty({ example: 'booking-funnel' }) report!: string;
  @ApiProperty({
    description:
      'How the numbers are calculated (PROPOSED in FRD section 7 until the business confirms).',
  })
  definition!: string;
  @ApiProperty({ type: [String], description: 'Known limits of what the data can answer.' })
  notes!: string[];
  @ApiProperty({ nullable: true }) from!: string | null;
  @ApiProperty({ nullable: true }) to!: string | null;
  @ApiProperty({ description: 'Report-specific content.' }) data!: T;
  @ApiPropertyOptional({ description: 'Present on paginated reports.' }) meta?: {
    page: number;
    limit: number;
    total: number;
  };
}

export class ReportCatalogEntry {
  @ApiProperty() report!: string;
  @ApiProperty() requirement!: string;
  @ApiProperty() path!: string;
  @ApiProperty() definition!: string;
  @ApiProperty({ type: [String] }) notes!: string[];
}
