import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import {
  AdminPricingGuidanceController,
  PricingGuidanceController,
  PricingGuidanceService,
} from './pricing-guidance';
import { CategorySeedService } from './category-seed.service';
import {
  AdminServiceCategoriesController,
  ServiceCategoriesController,
} from './service-categories.controller';
import { ServiceCategoriesRepository } from './service-categories.repository';
import { ServiceCategoriesService } from './service-categories.service';

/**
 * Service Categories: the admin-managed category master (FRD FM-16). Owns `service_categories`; other modules read it
 * only through the exported service.
 */
@Module({
  imports: [UsersModule],
  controllers: [
    ServiceCategoriesController,
    AdminServiceCategoriesController,
    PricingGuidanceController,
    AdminPricingGuidanceController,
  ],
  providers: [
    ServiceCategoriesRepository,
    ServiceCategoriesService,
    CategorySeedService,
    PricingGuidanceService,
  ],
  exports: [ServiceCategoriesService, CategorySeedService],
})
export class ServiceCategoriesModule {}
