import { Module } from '@nestjs/common';
import { ServiceCategoriesModule } from '../service-categories/service-categories.module';
import { UsersModule } from '../users/users.module';
import { WorkerSubmissionRegistry } from './worker-submission.registry';
import { AdminWorkersController, WorkersController } from './workers.controller';
import { WorkersRepository } from './workers.repository';
import { WorkersService } from './workers.service';

/**
 * Workers: the worker profile / work profile (FRD FM-04). Owns `worker_profiles`, `worker_skills`, `worker_languages`.
 * Depends on Users (account) and Service Categories (role master). Availability and, later, Search/Matching/Verification
 * depend on this module through `WorkersService` and `WorkerSubmissionRegistry`, never the reverse.
 */
@Module({
  imports: [UsersModule, ServiceCategoriesModule],
  controllers: [WorkersController, AdminWorkersController],
  providers: [WorkersRepository, WorkersService, WorkerSubmissionRegistry],
  exports: [WorkersService, WorkerSubmissionRegistry],
})
export class WorkersModule {}
