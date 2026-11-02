import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import { WorkerCard } from '../../search/dto/search.dto';
import { PageQueryDto } from '../../../common/pagination/pagination';

export class ShortlistQuery extends PageQueryDto {
  @ApiPropertyOptional({
    example: 'HOUSE_MAID',
    description:
      'Only workers offering this category code. Workers who are no longer available are left out when it is set.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  category?: string;
}

export class ShortlistCategoryCountView {
  @ApiProperty({ example: 'HOUSE_MAID' }) code!: string;
  @ApiProperty({ example: 'House Maid' }) name!: string;
  @ApiProperty({ description: 'Shortlisted, currently available workers offering this category.' })
  count!: number;
}

export class ShortlistItemView {
  @ApiProperty() workerId!: string;
  @ApiProperty() addedAt!: Date;
  @ApiProperty({
    description:
      'false when the worker is no longer visible to customers (suspended, re-check due, profile changed). Remove the entry or wait.',
  })
  available!: boolean;
  @ApiProperty({ type: WorkerCard, nullable: true, description: 'null when not available.' })
  worker!: WorkerCard | null;
}
