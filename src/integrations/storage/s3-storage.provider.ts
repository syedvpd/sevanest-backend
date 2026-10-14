import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ProviderError } from '../provider-error';
import type { SignedUrl, StorageProvider } from './storage-provider.interface';

export interface S3StorageSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * S3-compatible adapter (Supabase Storage). The bucket is private; access is only through short-lived signed URLs.
 * A presigned PUT cannot cap the body size, so callers must confirm the real size with `getObjectInfo` after upload.
 * Deletion is used only for uploads that failed validation or were never confirmed (retention of confirmed documents is undecided).
 */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly settings: S3StorageSettings) {
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
    });
  }

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<SignedUrl> {
    const url = await this.sign(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      }),
      input.ttlSeconds,
    );
    return { url, expiresAt: new Date(Date.now() + input.ttlSeconds * 1000) };
  }

  async createDownloadUrl(input: { objectKey: string; ttlSeconds: number }): Promise<SignedUrl> {
    const url = await this.sign(
      new GetObjectCommand({ Bucket: this.settings.bucket, Key: input.objectKey }),
      input.ttlSeconds,
    );
    return { url, expiresAt: new Date(Date.now() + input.ttlSeconds * 1000) };
  }

  async getObjectInfo(objectKey: string): Promise<{ sizeBytes: number; etag?: string } | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.settings.bucket, Key: objectKey }),
      );
      return { sizeBytes: head.ContentLength ?? 0, etag: head.ETag?.replaceAll('"', '') };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw this.toProviderError(error);
    }
  }

  async readObjectHead(objectKey: string, length: number): Promise<Buffer | null> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.settings.bucket,
          Key: objectKey,
          Range: `bytes=0-${Math.max(1, length) - 1}`,
        }),
      );
      return Buffer.from((await object.Body?.transformToByteArray()) ?? []);
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        (error.$metadata.httpStatusCode === 404 || error.name === 'NoSuchKey')
      ) {
        return null;
      }
      throw this.toProviderError(error);
    }
  }

  async readObject(
    objectKey: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; truncated: boolean } | null> {
    try {
      // One byte more than allowed: its presence proves the object is larger without downloading all of it.
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.settings.bucket,
          Key: objectKey,
          Range: `bytes=0-${Math.max(1, maxBytes)}`,
        }),
      );
      const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? []);
      return bytes.length > maxBytes
        ? { bytes: bytes.subarray(0, maxBytes), truncated: true }
        : { bytes, truncated: false };
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        (error.$metadata.httpStatusCode === 404 || error.name === 'NoSuchKey')
      ) {
        return null;
      }
      throw this.toProviderError(error);
    }
  }

  async putObject(input: {
    objectKey: string;
    body: Buffer;
    contentType: string;
    cacheControl?: string;
  }): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.settings.bucket,
          Key: input.objectKey,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.body.length,
          CacheControl: input.cacheControl,
        }),
      );
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      // S3 answers 204 whether or not the key existed.
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: objectKey }),
      );
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  private async sign(
    command: PutObjectCommand | GetObjectCommand,
    ttlSeconds: number,
  ): Promise<string> {
    try {
      return await getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  private toProviderError(error: unknown): ProviderError {
    const status = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
    const retryable = status === undefined || status >= 500 || status === 429;
    return new ProviderError('storage', 'Object storage request failed', retryable, error);
  }
}
