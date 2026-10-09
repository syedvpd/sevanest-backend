import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { LANGUAGE_CODE } from '../../../common/validation/language';
import { TIME_OF_DAY } from '../../availability/domain/time-windows';
import { AreaRefView, AvailabilityWindowView, CategoryRefView } from '../../search/dto/search.dto';
import { ENGAGEMENTS, type Engagement } from '../../search/search.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * One customer requirement (FRD FM-03 fields). Matching needs the whole requirement: category, location, engagement and the
 * timings. Salary/budget and start date are not matched on (no salary period, no effective dates are defined; Q-39, Q-45).
 */
export class MatchRequirementDto extends PageQueryDto {
  @ApiProperty({ example: 'HOUSE_MAID' })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  category!: string;

  @ApiProperty({ description: 'Service area of the job; only enabled areas.' })
  @IsUUID()
  areaId!: string;

  @ApiProperty({ enum: ENGAGEMENTS })
  @IsIn(ENGAGEMENTS)
  engagement!: Engagement;

  @ApiProperty({ example: '09:00' })
  @Matches(TIME_OF_DAY, { message: 'availableFrom must be HH:mm' })
  availableFrom!: string;

  @ApiProperty({ example: '13:00' })
  @Matches(TIME_OF_DAY, { message: 'availableTo must be HH:mm' })
  availableTo!: string;

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
}

export class CandidateView {
  @ApiProperty() workerId!: string;
  @ApiProperty({
    description: 'The worker account, for /admin/users/{userId}/status and /admin/workers.',
  })
  userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) experienceMonths!: number | null;
  @ApiProperty({ type: [CategoryRefView] }) categories!: CategoryRefView[];
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: [AreaRefView] }) serviceAreas!: AreaRefView[];
  @ApiProperty({ enum: ENGAGEMENTS, nullable: true }) engagementPreference!: Engagement | null;
  @ApiProperty({ type: [AvailabilityWindowView] }) availability!: AvailabilityWindowView[];
}

export class MatchMeta {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
}

export class MatchCandidatesResponse {
  @ApiProperty({ type: [CandidateView] }) data!: CandidateView[];
  @ApiProperty({ type: MatchMeta }) meta!: MatchMeta;
  @ApiProperty({
    enum: ['SUBMITTED_ASC'],
    description: 'Stable order: earliest submitted profile first. It is NOT a suitability ranking.',
  })
  ordering!: 'SUBMITTED_ASC';
  @ApiProperty({
    description:
      'Always false: no scoring or ranking rule is defined (Q-46); every candidate meets every criterion.',
  })
  ranked!: false;
}
