import { Injectable } from '@nestjs/common';
import type { SignedUrl, StorageProvider } from './storage-provider.interface';

/**
 * Deterministic storage adapter for automated tests and local work: objects are sizes kept in process memory and the
 * "signed URLs" are inert `memory://` strings. Configuration validation refuses STORAGE_PROVIDER=memory in production.
 */
@Injectable()
export class InMemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, number>();
  readonly issuedUploads: Array<{ objectKey: string; contentType: string; maxBytes: number }> = [];
  readonly issuedDownloads: string[] = [];

  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<SignedUrl> {
    this.issuedUploads.push({
      objectKey: input.objectKey,
      contentType: input.contentType,
      maxBytes: input.maxBytes,
    });
    return Promise.resolve({
      url: `memory://upload/${encodeURIComponent(input.objectKey)}?sig=test`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    });
  }

  createDownloadUrl(input: { objectKey: string; ttlSeconds: number }): Promise<SignedUrl> {
    this.issuedDownloads.push(input.objectKey);
    return Promise.resolve({
      url: `memory://download/${encodeURIComponent(input.objectKey)}?sig=test`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    });
  }

  getObjectInfo(objectKey: string): Promise<{ sizeBytes: number } | null> {
    const size = this.objects.get(objectKey);
    return Promise.resolve(size === undefined ? null : { sizeBytes: size });
  }

  /** Test helper: stands in for the client uploading to the signed URL. */
  simulateUpload(objectKey: string, sizeBytes: number): void {
    this.objects.set(objectKey, sizeBytes);
  }
}
