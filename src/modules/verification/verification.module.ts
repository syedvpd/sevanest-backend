import { Module } from '@nestjs/common';
import { StorageModule } from '../../integrations/storage/storage.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import {
  AdminVerificationController,
  AdminWorkerVerificationController,
  WorkerVerificationController,
} from './verification.controller';
import { VerificationRepository } from './verification.repository';
import { VerificationService } from './verification.service';

/**
 * Worker Verification / KYC (FRD FM-05). Owns the verification tables and the definition of "fully verified"
 * (`verification-eligibility.ts`), which Search and Matching consume. Depends on Workers (existence, ownership) and Users.
 * Private object storage comes from the shared StorageModule (`s3`, `disabled`, test-only `memory`).
 */
@Module({
  imports: [UsersModule, WorkersModule, StorageModule],
  controllers: [
    WorkerVerificationController,
    AdminVerificationController,
    AdminWorkerVerificationController,
  ],
  providers: [VerificationRepository, VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
