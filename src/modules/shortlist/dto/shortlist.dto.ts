import { ApiProperty } from '@nestjs/swagger';
import { WorkerCard } from '../../search/dto/search.dto';
import { PageQueryDto } from '../../../common/pagination/pagination';

export class ShortlistQuery extends PageQueryDto {}

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
