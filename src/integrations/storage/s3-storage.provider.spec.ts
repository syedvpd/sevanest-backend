import { S3ServiceException } from '@aws-sdk/client-s3';
import { ProviderError } from '../provider-error';
import { S3StorageProvider } from './s3-storage.provider';

const settings = {
  endpoint: 'https://project-ref.storage.example/storage/v1/s3',
  region: 'ap-south-1',
  bucket: 'kyc-test-bucket',
  accessKeyId: 'AKIATESTKEY0000000',
  secretAccessKey: 'test-secret-access-key-do-not-leak-0123456789',
};

function notFound(): S3ServiceException {
  return new S3ServiceException({
    name: 'NotFound',
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
  });
}

describe('S3StorageProvider', () => {
  const provider = new S3StorageProvider(settings);

  it('signs a short-lived upload URL locally: bucket, key, content type and expiry, never the secret key', async () => {
    const before = Date.now();
    const { url, expiresAt } = await provider.createUploadUrl({
      objectKey: 'kyc/worker/abc',
      contentType: 'application/pdf',
      maxBytes: 1000,
      ttlSeconds: 120,
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://project-ref.storage.example/storage/v1/s3/kyc-test-bucket/kyc/worker/abc',
    );
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    expect(url).not.toContain(settings.secretAccessKey);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('signs a download URL that differs per object and expires', async () => {
    const a = await provider.createDownloadUrl({ objectKey: 'kyc/w/one', ttlSeconds: 60 });
    const b = await provider.createDownloadUrl({ objectKey: 'kyc/w/two', ttlSeconds: 60 });
    expect(new URL(a.url).searchParams.get('X-Amz-Expires')).toBe('60');
    expect(a.url).not.toBe(b.url);
    expect(a.url).toContain('kyc/w/one');
  });

  it('answers null for a missing object and the size for a present one', async () => {
    const client = (provider as unknown as { client: { send: jest.Mock } }).client;
    const send = jest.spyOn(client, 'send');
    send.mockRejectedValueOnce(notFound());
    expect(await provider.getObjectInfo('kyc/missing')).toBeNull();
    send.mockResolvedValueOnce({ ContentLength: 1234 } as never);
    expect(await provider.getObjectInfo('kyc/present')).toEqual({ sizeBytes: 1234 });
    send.mockResolvedValueOnce({} as never);
    expect(await provider.getObjectInfo('kyc/no-length')).toEqual({ sizeBytes: 0 });
    send.mockRestore();
  });

  it('turns storage failures into ProviderErrors without provider text, retryable only for outages', async () => {
    const client = (provider as unknown as { client: { send: jest.Mock } }).client;
    const send = jest.spyOn(client, 'send');
    const fail = (status: number | undefined) =>
      send.mockRejectedValueOnce(
        status === undefined
          ? new Error('connect ECONNREFUSED secret-host')
          : new S3ServiceException({
              name: 'X',
              $fault: 'server',
              $metadata: { httpStatusCode: status },
              message: 'secret detail',
            }),
      );
    for (const [status, retryable] of [
      [403, false],
      [400, false],
      [500, true],
      [503, true],
      [429, true],
      [undefined, true],
    ] as const) {
      fail(status);
      const error = await provider.getObjectInfo('kyc/x').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(retryable);
      expect((error as ProviderError).message).toBe('Object storage request failed');
    }
    send.mockRestore();
  });
});
