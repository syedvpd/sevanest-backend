import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const TAG_SENTIMENTS = ['POSITIVE', 'NEGATIVE'] as const;
export type TagSentiment = (typeof TAG_SENTIMENTS)[number];

export class AppSettingView {
  @ApiProperty({ example: 'supportPhone' }) key!: string;
  @ApiProperty({ enum: ['string', 'boolean'] }) kind!: string;
  @ApiProperty() description!: string;
  @ApiProperty({
    nullable: true,
    oneOf: [{ type: 'string' }, { type: 'boolean' }],
    description: 'The value the apps receive now; null when nothing is set.',
  })
  value!: string | boolean | null;
  @ApiProperty({
    enum: ['DATABASE', 'ENVIRONMENT', 'UNSET'],
    description: 'DATABASE = set here; ENVIRONMENT = deployment default; UNSET = no value.',
  })
  source!: string;
  @ApiProperty({ nullable: true, type: Date }) updatedAt!: Date | null;
}

export class SetAppSettingDto {
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'boolean' }],
    description: 'A string, or true/false for `maintenance`. The format is checked per key.',
  })
  @IsDefined()
  value!: string | boolean;
}

export class RatingTagAdminView {
  @ApiProperty({ example: 'PUNCTUAL' }) code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: TAG_SENTIMENTS }) sentiment!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() updatedAt!: Date;
}

export class CreateRatingTagDto {
  @ApiProperty({
    example: 'PUNCTUAL',
    description: 'Stable code: A-Z, 0-9, underscore. Never changes.',
  })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/)
  code!: string;

  @ApiProperty({ maxLength: 60, description: 'Text shown in the app.' })
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  label!: string;

  @ApiProperty({ enum: TAG_SENTIMENTS })
  @IsEnum(TAG_SENTIMENTS)
  sentiment!: TagSentiment;

  @ApiPropertyOptional({ default: 0, description: 'Lower numbers are listed first.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

export class UpdateRatingTagDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  label?: string;

  @ApiPropertyOptional({ enum: TAG_SENTIMENTS })
  @IsOptional()
  @IsEnum(TAG_SENTIMENTS)
  sentiment?: TagSentiment;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'false retires the tag: new ratings cannot use it, old ones keep it.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
