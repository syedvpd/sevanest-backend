import { Injectable } from '@nestjs/common';
import { buildSampleFile } from './file-signature';
import { ProviderError } from '../provider-error';
import type { SignedUrl, StorageProvider } from './storage-provider.interface';

/**
 * Deterministic storage adapter for automated tests and local work: objects are sizes kept in process memory and the
 * "signed URLs" are inert `memory://` strings. Configuration validation refuses STORAGE_PROVIDER=memory in production.
 */
@Injectable()
export class InMemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, number>();
  private readonly contents = new Map<string, Buffer>();
  private readonly contentTypes = new Map<string, string>();
  /** Keys removed through deleteObject (so tests can assert a rejected upload was discarded). */
  readonly deleted: string[] = [];
  /** Test switch: the next deleteObject fails like an unreachable storage. */
  failNextDelete = false;
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

  getObjectInfo(objectKey: string): Promise<{ sizeBytes: number; etag?: string } | null> {
    const size = this.objects.get(objectKey);
    return Promise.resolve(size === undefined ? null : { sizeBytes: size, etag: `etag-${size}` });
  }

  readObjectHead(objectKey: string, length: number): Promise<Buffer | null> {
    const content = this.contents.get(objectKey);
    return Promise.resolve(content === undefined ? null : content.subarray(0, length));
  }

  readObject(
    objectKey: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; truncated: boolean } | null> {
    const content = this.contents.get(objectKey);
    if (content === undefined) return Promise.resolve(null);
    return Promise.resolve(
      content.length > maxBytes
        ? { bytes: content.subarray(0, maxBytes), truncated: true }
        : { bytes: content, truncated: false },
    );
  }

  putObject(input: { objectKey: string; body: Buffer; contentType: string }): Promise<void> {
    this.objects.set(input.objectKey, input.body.length);
    this.contents.set(input.objectKey, Buffer.from(input.body));
    this.contentTypes.set(input.objectKey, input.contentType);
    return Promise.resolve();
  }

  /** Test helper: the content type a server-side write stored. */
  contentTypeOf(objectKey: string): string | undefined {
    return this.contentTypes.get(objectKey);
  }

  deleteObject(objectKey: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      return Promise.reject(new ProviderError('storage', 'storage unavailable', true));
    }
    this.objects.delete(objectKey);
    this.contents.delete(objectKey);
    this.deleted.push(objectKey);
    return Promise.resolve();
  }

  has(objectKey: string): boolean {
    return this.objects.has(objectKey);
  }

  /**
   * Test helper: stands in for the client uploading to the signed URL. Without `content` the object is a well-formed file of
   * the content type the upload URL was issued for, `sizeBytes` long (an honest client); pass `content` to simulate anything
   * else (the stored size is then `sizeBytes`, which may deliberately disagree with the content).
   */
  simulateUpload(objectKey: string, sizeBytes: number, content?: Buffer): void {
    this.objects.set(objectKey, sizeBytes);
    const issued = this.issuedUploads.find((u) => u.objectKey === objectKey);
    this.contents.set(
      objectKey,
      content ??
        (issued ? buildSampleFile(issued.contentType, sizeBytes) : Buffer.alloc(sizeBytes)),
    );
  }

  /** Test helper: the stored bytes change after confirmation (a swapped object). */
  replaceContent(objectKey: string, content: Buffer): void {
    this.contents.set(objectKey, content);
    this.objects.set(objectKey, content.length);
  }
}
