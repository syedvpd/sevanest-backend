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
    enum: ['EXPERIENCE_DESC', 'EXPERIENCE_ASC'],
    default: 'EXPERIENCE_DESC',
    description:
      'A stable ordering by the stated attribute, not a relevance ranking (none is defined).',
  })
  @IsOptional()
  @IsIn(['EXPERIENCE_DESC', 'EXPERIENCE_ASC'])
  sort: 'EXPERIENCE_DESC' | 'EXPERIENCE_ASC' = 'EXPERIENCE_DESC';
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

/**
 * The worker card (FR-WD-001): experience, skills, language, area, availability and the verification badge. It carries no
 * name, contact detail, address, emergency contact, salary, document or internal identifier of the account (FR-WD-007).
 * The profile photo and the rating summary are not available yet (photo upload and Ratings are not built).
 */
export class WorkerCard {
  @ApiProperty({ description: 'Opaque worker reference for the next step (not the account id).' })
  workerId!: string;
  @ApiProperty({ nullable: true, description: 'Total months.' }) experienceMonths!: number | null;
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
}
