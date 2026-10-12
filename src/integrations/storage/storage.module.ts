import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { StorageProviderKind } from '../../config/env.validation';
import { DisabledStorageProvider } from './disabled-storage.provider';
import { InMemoryStorageProvider } from './in-memory-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { STORAGE_PROVIDER } from './storage-provider.interface';

/**
 * The ONE private-object-storage provider instance, shared by KYC documents and profile photos. Adapters: `s3`
 * (S3-compatible, Supabase Storage), `disabled` (every call fails, nothing is stored) and the test-only `memory`.
 */
@Module({
  providers: [
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
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
