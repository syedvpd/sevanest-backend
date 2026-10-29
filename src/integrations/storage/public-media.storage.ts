import type { StorageProvider } from './storage-provider.interface';

export const PUBLIC_MEDIA_STORAGE = Symbol('PUBLIC_MEDIA_STORAGE');

/** Keys in the public bucket start with this; every other key lives in the private bucket and is served by signed links. */
export const PUBLIC_KEY_PREFIX = 'pub/';
/** A public key never changes content (a new image gets new keys), so browsers and apps may keep it for good. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const isPublicKey = (key: string): boolean => key.startsWith(PUBLIC_KEY_PREFIX);

/**
 * Public image bucket (D-93): worker photos and category images, served from permanent links with no signing. KYC documents,
 * originals and customer photos are never written here. `enabled` is false until STORAGE_PUBLIC_BASE_URL is set, and callers
 * then keep using the private bucket and signed links exactly as before.
 */
export class PublicMediaStorage {
  constructor(
    readonly provider: StorageProvider | null,
    private readonly baseUrl: string | null,
  ) {}

  get enabled(): boolean {
    return this.provider !== null && this.baseUrl !== null;
  }

  urlFor(objectKey: string): string {
    return `${this.baseUrl}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(objectKey: string, body: Buffer, contentType: string): Promise<void> {
    return this.require().putObject({
      objectKey,
      body,
      contentType,
      cacheControl: PUBLIC_CACHE_CONTROL,
    });
  }

  async delete(objectKey: string): Promise<void> {
    return this.require().deleteObject(objectKey);
  }

  private require(): StorageProvider {
    if (!this.provider) throw new Error('Public media storage is not configured');
    return this.provider;
  }
}
