import { Module } from '@nestjs/common';
import { StorageProviderKind } from '../../config/env.validation';
import { AppConfigService } from '../../config/app-config.service';
import { DisabledStorageProvider } from '../../integrations/storage/disabled-storage.provider';
import { S3StorageProvider } from '../../integrations/storage/s3-storage.provider';
import { InMemoryStorageProvider } from '../../integrations/storage/in-memory-storage.provider';
import { STORAGE_PROVIDER } from '../../integrations/storage/storage-provider.interface';
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
 * Private object storage sits behind STORAGE_PROVIDER; adapters: `s3` (S3-compatible, Supabase Storage), `disabled`, and the test-only
 * `memory`.
 */
@Module({
  imports: [UsersModule, WorkersModule],
  controllers: [
    WorkerVerificationController,
    AdminVerificationController,
    AdminWorkerVerificationController,
  ],
  providers: [
    VerificationRepository,
    VerificationService,
    {
      provide: STORAGE_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        switch (config.storageProvider) {
          case StorageProviderKind.S3:
            return new S3StorageProvider(config.storageS3);
          case StorageProviderKind.Memory:
            return new InMemoryStorageProvider();
          default:
            return new DisabledStorageProvider();
        }
      },
    },
  ],
  exports: [VerificationService],
})
export class VerificationModule {}
