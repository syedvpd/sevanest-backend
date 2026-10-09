import { Injectable } from '@nestjs/common';
import { ProviderError } from '../provider-error';
import type { SignedUrl, StorageProvider } from './storage-provider.interface';

/** Used while no object-storage vendor is configured (Q-08). Every call fails with a non-retryable ProviderError. */
@Injectable()
export class DisabledStorageProvider implements StorageProvider {
  createUploadUrl(): Promise<SignedUrl> {
    return Promise.reject(
      new ProviderError('storage', 'Document storage is not configured', false),
    );
  }

  createDownloadUrl(): Promise<SignedUrl> {
    return Promise.reject(
      new ProviderError('storage', 'Document storage is not configured', false),
    );
  }

  getObjectInfo(): Promise<{ sizeBytes: number } | null> {
    return Promise.reject(
      new ProviderError('storage', 'Document storage is not configured', false),
    );
  }
}
