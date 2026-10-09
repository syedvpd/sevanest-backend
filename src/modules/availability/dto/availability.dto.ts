import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
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

const ENGAGEMENT = ['FULL_TIME', 'PART_TIME', 'LIVE_IN'] as const;

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
}

export class ServiceAreaListQuery extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only areas of this city (case-insensitive).' })
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
