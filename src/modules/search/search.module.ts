import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { ServiceCategoriesModule } from '../service-categories/service-categories.module';
import { SearchController } from './search.controller';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';

/**
 * Search: read-only worker discovery. Resolves the category and area through their owning modules and answers the query
 * in one SQL statement (see SearchRepository). Verification's "fully verified" definition is imported as a SQL fragment.
 * Matching builds on `SearchService.findEligible`; nothing depends on Matching.
 */
@Module({
  imports: [ServiceCategoriesModule, AvailabilityModule],
  controllers: [SearchController],
  providers: [SearchRepository, SearchService],
  exports: [SearchService],
})
export class SearchModule {}
