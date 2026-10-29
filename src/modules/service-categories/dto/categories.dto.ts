import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { ENGAGEMENTS } from '../../../common/validation/engagements';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/*
 * Length caps are TECHNICAL bounds (the specs set no field limits, Q-12). The stable machine code is UPPER_SNAKE_CASE.
 */
const CODE = /^[A-Z][A-Z0-9_]{1,49}$/;

export class CreateServiceCategoryDto {
  @ApiProperty({
    example: 'HOUSE_MAID',
    description: 'Stable machine code. Cannot be changed later.',
  })
  @IsString()
  @Matches(CODE, { message: 'code must be UPPER_SNAKE_CASE, 2-50 characters' })
  code!: string;

  @ApiProperty({ example: 'House Maid', description: 'Unique ignoring case.' })
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @Length(1, 500)
  description?: string | null;
}

/** The code is immutable and `isEnabled` is the only way to retire a category. */
export class UpdateServiceCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  name?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null or empty clears it.', type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @Length(1, 500)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class AdminCategoryListQuery extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Filter by enabled state.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isEnabled?: boolean;
}

/** Permanent public links (D-93): safe to cache by `cacheKey`, which changes only when the image is replaced. */
export class CategoryImageLinks {
  @ApiProperty({ description: 'Small square WebP (320 px) for lists and cards.' }) url!: string;
  @ApiProperty({ description: 'Larger WebP (longest side at most 1080 px).' }) largeUrl!: string;
  @ApiProperty() cacheKey!: string;
}

/** What customers and workers see: enabled categories only, no internal state. */
export class ServiceCategoryResponse {
  @ApiProperty() id!: string;
  @ApiProperty({
    type: [String],
    description: 'Engagement types this category offers; empty = not restricted.',
  })
  allowedEngagements!: string[];
  @ApiProperty({
    type: [String],
    example: ['PART_TIME', 'FULL_TIME', 'LIVE_IN'],
    description:
      'Same value as allowedEngagements, named like the admin PUT body (`engagements`). Empty = not restricted.',
  })
  engagements!: string[];
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({
    nullable: true,
    type: CategoryImageLinks,
    description: 'null = no image (or public image storage is not configured).',
  })
  image!: CategoryImageLinks | null;
}

export class SetCategoryEngagementsDto {
  @ApiProperty({
    enum: ENGAGEMENTS,
    isArray: true,
    description: 'The engagement types the category offers. An empty list removes the restriction.',
  })
  @IsArray()
  @ArrayMaxSize(ENGAGEMENTS.length)
  @IsIn(ENGAGEMENTS, { each: true })
  engagements!: string[];
}

export class AdminServiceCategoryResponse extends ServiceCategoryResponse {
  @ApiProperty() isEnabled!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
