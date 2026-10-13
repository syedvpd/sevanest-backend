import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { ShortlistController } from './shortlist.controller';
import { ShortlistRepository } from './shortlist.repository';
import { ShortlistService } from './shortlist.service';

/** Customer shortlist (FR-WD-005). Depends on Search for "which workers can a customer see"; nothing depends on it. */
@Module({
  imports: [SearchModule],
  controllers: [ShortlistController],
  providers: [ShortlistRepository, ShortlistService],
  exports: [ShortlistService],
})
export class ShortlistModule {}
