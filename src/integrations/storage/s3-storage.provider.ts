import {
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
 * No delete operation is exposed until the retention policy exists (SRS §14 item 2).
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

  async getObjectInfo(objectKey: string): Promise<{ sizeBytes: number } | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.settings.bucket, Key: objectKey }),
      );
      return { sizeBytes: head.ContentLength ?? 0 };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
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
