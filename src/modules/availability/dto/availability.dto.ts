import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  Max,
  Min,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { TIME_OF_DAY } from '../domain/time-windows';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

const ENGAGEMENT = [
  'FULL_TIME',
  'PART_TIME',
  'LIVE_IN',
  'DAILY',
  'HOURLY',
  'SHIFT',
  'ONE_TIME',
] as const;

/** Sizes below are TECHNICAL bounds (the specs set no limits), not product rules. */
export class TimeWindowDto {
  @ApiProperty({ example: '09:00', description: '24-hour HH:mm, local time (India).' })
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'start must be a time such as "09:00"' })
  start!: string;

  @ApiProperty({ example: '13:00', description: 'After start; "24:00" means midnight.' })
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'end must be a time such as "13:00" (or "24:00")' })
  end!: string;
}

/**
 * Step 6 of onboarding (areas, timings, preference). Every part is optional; a part that is sent REPLACES the stored
 * one. Overlapping or inverted windows are rejected.
 */
export class UpdateAvailabilityDto {
  @ApiPropertyOptional({
    enum: ENGAGEMENT,
    description: 'Full-time, part-time or live-in preference (FR-WP-006).',
  })
  @IsOptional()
  @IsIn(ENGAGEMENT)
  engagementPreference?: (typeof ENGAGEMENT)[number];

  @ApiPropertyOptional({
    type: [String],
    description: 'Preferred work locations: ids of enabled service areas.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  areaIds?: string[];

  @ApiPropertyOptional({
    type: [TimeWindowDto],
    description:
      'Daily available timings, applied every day. No weekdays are defined by the specifications.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => TimeWindowDto)
  timeWindows?: TimeWindowDto[];
}

export class CreateServiceAreaDto {
  @ApiProperty({ example: 'Madhapur' })
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  name!: string;

  @ApiProperty({ example: 'Hyderabad' })
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  city!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Map centre of the area (set with the longitude and radius, or clear all three with null).',
    type: Number,
  })
  @IsOptional()
  @IsLatitude()
  centerLatitude?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsLongitude()
  centerLongitude?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 100,
    maximum: 100000,
    description: 'Radius in metres around the centre.',
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(100000)
  radiusMeters?: number | null;
}

export class UpdateServiceAreaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Map centre of the area (set with the longitude and radius, or clear all three with null).',
    type: Number,
  })
  @IsOptional()
  @IsLatitude()
  centerLatitude?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsLongitude()
  centerLongitude?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 100,
    maximum: 100000,
    description: 'Radius in metres around the centre.',
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(100000)
  radiusMeters?: number | null;
}

export class ServiceAreaListQuery extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only areas of this city (case-insensitive).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  city?: string;
}

export class ResolveAreaQuery {
  @ApiPropertyOptional({ description: 'Position from the device. Needs longitude too.' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({
    description:
      'Area name as returned by a geocoder (case-insensitive exact match). Used when no position is given or no area covers it.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  name?: string;

  @ApiPropertyOptional({ description: 'Narrow a name match to one city.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  city?: string;
}

export class AdminServiceAreaListQuery extends ServiceAreaListQuery {
  @ApiPropertyOptional({ description: 'Filter by enabled state.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isEnabled?: boolean;
}

// --- responses -------------------------------------------------------------------------------------------------

export class ServiceAreaResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() city!: string;
}

export class AdminServiceAreaResponse extends ServiceAreaResponse {
  @ApiProperty() isEnabled!: boolean;
  @ApiProperty({ nullable: true, type: Number }) centerLatitude!: number | null;
  @ApiProperty({ nullable: true, type: Number }) centerLongitude!: number | null;
  @ApiProperty({ nullable: true, type: Number }) radiusMeters!: number | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class WorkerAreaRef extends ServiceAreaResponse {
  @ApiProperty({ description: 'False when an admin disabled the area after the worker chose it.' })
  isEnabled!: boolean;
}

export class TimeWindowResponse extends TimeWindowDto {}

export class WorkerAvailabilityResponse {
  @ApiProperty({ enum: ENGAGEMENT, nullable: true }) engagementPreference!: string | null;
  @ApiProperty({ type: [WorkerAreaRef] }) areas!: WorkerAreaRef[];
  @ApiProperty({ type: [TimeWindowResponse], description: 'Sorted by start.' })
  timeWindows!: TimeWindowResponse[];
}
