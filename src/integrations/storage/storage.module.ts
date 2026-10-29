import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { StorageProviderKind } from '../../config/env.validation';
import { DisabledStorageProvider } from './disabled-storage.provider';
import { InMemoryStorageProvider } from './in-memory-storage.provider';
import { PUBLIC_MEDIA_STORAGE, PublicMediaStorage } from './public-media.storage';
import { S3StorageProvider } from './s3-storage.provider';
import { STORAGE_PROVIDER } from './storage-provider.interface';

/**
 * The ONE private-object-storage provider instance, shared by KYC documents and profile photos. Adapters: `s3`
 * (S3-compatible, Supabase Storage), `disabled` (every call fails, nothing is stored) and the test-only `memory`.
 * `PUBLIC_MEDIA_STORAGE` is the optional second, public bucket for permanent image links (D-93).
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
    {
      provide: PUBLIC_MEDIA_STORAGE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const settings = config.publicMedia;
        if (!settings) return new PublicMediaStorage(null, null);
        switch (config.storageProvider) {
          case StorageProviderKind.S3:
            return new PublicMediaStorage(
              new S3StorageProvider({ ...config.storageS3, bucket: settings.bucket! }),
              settings.baseUrl,
            );
          case StorageProviderKind.Memory:
            return new PublicMediaStorage(new InMemoryStorageProvider(), settings.baseUrl);
          default:
            return new PublicMediaStorage(null, null);
        }
      },
    },
  ],
  exports: [STORAGE_PROVIDER, PUBLIC_MEDIA_STORAGE],
})
export class StorageModule {}
