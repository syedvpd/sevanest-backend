import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import {
  AdminServiceAreasController,
  AdminWorkerAvailabilityController,
  ServiceAreasController,
  WorkerAvailabilityController,
} from './availability.controller';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';
import { ServiceAreasService } from './service-areas.service';

/**
 * Availability: worker engagement preference, preferred service areas and daily time windows, plus the service-area master.
 * Depends on Workers (ownership, existence) and Users; Workers does not depend on it (Availability contributes its
 * submission requirements through WorkerSubmissionRegistry). Future Search/Matching read it through this module.
 */
@Module({
  imports: [UsersModule, WorkersModule],
  controllers: [
    ServiceAreasController,
    AdminServiceAreasController,
    WorkerAvailabilityController,
    AdminWorkerAvailabilityController,
  ],
  providers: [AvailabilityRepository, AvailabilityService, ServiceAreasService],
  exports: [AvailabilityService, ServiceAreasService],
})
export class AvailabilityModule {}
