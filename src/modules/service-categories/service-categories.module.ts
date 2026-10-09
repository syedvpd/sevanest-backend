import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
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
  controllers: [ServiceCategoriesController, AdminServiceCategoriesController],
  providers: [ServiceCategoriesRepository, ServiceCategoriesService, CategorySeedService],
  exports: [ServiceCategoriesService, CategorySeedService],
})
export class ServiceCategoriesModule {}
