import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

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

  @ApiPropertyOptional({ nullable: true, description: 'null or empty clears it.' })
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

/** What customers and workers see: enabled categories only, no internal state. */
export class ServiceCategoryResponse {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
}

export class AdminServiceCategoryResponse extends ServiceCategoryResponse {
  @ApiProperty() isEnabled!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
