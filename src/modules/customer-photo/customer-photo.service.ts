import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AppConfigService } from '../../config/app-config.service';
import { MALWARE_SCANNER, type MalwareScanner } from '../../integrations/malware/malware-scanner';
import { ProviderError } from '../../integrations/provider-error';
import { matchesDeclaredType, SIGNATURE_BYTES } from '../../integrations/storage/file-signature';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../integrations/storage/storage-provider.interface';
import type {
  PhotoLink,
  PhotoUploadResponse,
  RequestPhotoUploadDto,
} from '../worker-photo/dto/worker-photo.dto';
import {
  makeRenditions,
  RENDITION_CACHE_CONTROL,
  RENDITION_CONTENT_TYPE,
  renditionKeys,
  UnreadableImageError,
  type Renditions,
} from '../worker-photo/photo-renditions';
import { PHOTO_CONTENT_TYPES, PhotoErrorCode } from '../worker-photo/worker-photo.service';
import { CustomerPhotoRepository } from './customer-photo.repository';

/** Technical abuse guard (not a business rule): unconfirmed uploads one customer may hold at a time. */
const MAX_PENDING = 3;

/**
 * The customer's own profile photo. Identical safeguards to the worker photo: private storage, a short-lived signed upload URL,
 * server-side size and file-signature checks, optional malware scan, and server-made WebP renditions without camera metadata.
 * The size limit is business configuration (PROFILE_PHOTO_MAX_BYTES): until it is set the feature answers 503 rather than guessing.
 * Only the owner can read the photo; a customer's photo is not shown to anyone else.
 */
@Injectable()
export class CustomerPhotoService {
  private readonly logger = new Logger(CustomerPhotoService.name);

  constructor(
    private readonly repository: CustomerPhotoRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  async requestUpload(userId: string, dto: RequestPhotoUploadDto): Promise<PhotoUploadResponse> {
    const maxBytes = this.limit();
    if (!PHOTO_CONTENT_TYPES.includes(dto.contentType)) {
      throw new DomainException(
        PhotoErrorCode.PHOTO_TYPE_NOT_ALLOWED,
        'This image type is not accepted',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'contentType', messages: [`accepted types: ${PHOTO_CONTENT_TYPES.join(', ')}`] }],
      );
    }
    if (dto.sizeBytes > maxBytes) {
      throw new DomainException(
        ErrorCode.PAYLOAD_TOO_LARGE,
        'The image is larger than allowed',
        HttpStatus.PAYLOAD_TOO_LARGE,
        [{ field: 'sizeBytes', messages: [`at most ${maxBytes} bytes`] }],
      );
    }
    const objectKey = `customer-photos/${userId}/${randomUUID()}`;
    const upload = await this.storageCall(() =>
      this.storage.createUploadUrl({
        objectKey,
        contentType: dto.contentType,
        maxBytes: dto.sizeBytes,
        ttlSeconds: this.config.profilePhoto.signedUrlTtlSeconds,
      }),
    );
    const photoId = await this.repository.transaction(async (tx) => {
      await this.repository.lockCustomer(userId, tx);
      if ((await this.repository.countPending(userId, tx)) >= MAX_PENDING) {
        throw new DomainException(
          PhotoErrorCode.TOO_MANY_PENDING_PHOTOS,
          'Too many images are waiting to be confirmed',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const photo = await this.repository.create(
        {
          customerUserId: userId,
          objectKey,
          contentType: dto.contentType,
          sizeBytes: dto.sizeBytes,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'customer.photo_request',
          entityType: 'customer_profile_photo',
          entityId: photo.id,
          actorId: userId,
          metadata: { contentType: dto.contentType },
        },
        tx,
      );
      return photo.id;
    });
    return {
      photoId,
      url: upload.url,
      method: 'PUT',
      expiresAt: upload.expiresAt,
      contentType: dto.contentType,
      maxBytes: dto.sizeBytes,
    };
  }

  /** Repeating the call for a photo that is already current changes nothing. Another customer's photo answers 404. */
  async confirm(userId: string, photoId: string): Promise<{ photoId: string; status: 'READY' }> {
    const maxBytes = this.limit();
    const photo = await this.repository.find(photoId);
    if (!photo || photo.customerUserId !== userId) throw this.notFound();
    if (photo.status === 'READY') return { photoId, status: 'READY' };

    const info = await this.storageCall(() => this.storage.getObjectInfo(photo.objectKey));
    if (!info || info.sizeBytes <= 0 || info.sizeBytes > Math.min(photo.sizeBytes, maxBytes)) {
      // A concurrent confirmation may have finished and removed the original already.
      if ((await this.repository.find(photo.id))?.status === 'READY') {
        return { photoId, status: 'READY' };
      }
      throw this.notUploaded();
    }
    const head = await this.storageCall(() =>
      this.storage.readObjectHead(photo.objectKey, SIGNATURE_BYTES),
    );
    if (!head || !matchesDeclaredType(photo.contentType, head)) {
      throw await this.contentRejected(userId, photo.id);
    }
    const object = await this.storageCall(() => this.storage.readObject(photo.objectKey, maxBytes));
    if (!object || object.truncated) throw this.notUploaded();
    if (this.scanner.enabled) await this.scan(userId, photo.id, object.bytes);

    let renditions: Renditions;
    try {
      renditions = await makeRenditions(object.bytes);
    } catch (error) {
      if (error instanceof UnreadableImageError) throw await this.contentRejected(userId, photo.id);
      throw error;
    }
    const keys = renditionKeys(photo.objectKey);
    await this.storageCall(() =>
      Promise.all([
        this.storage.putObject({
          objectKey: keys.card,
          body: renditions.card,
          contentType: RENDITION_CONTENT_TYPE,
          cacheControl: RENDITION_CACHE_CONTROL,
        }),
        this.storage.putObject({
          objectKey: keys.large,
          body: renditions.large,
          contentType: RENDITION_CONTENT_TYPE,
          cacheControl: RENDITION_CACHE_CONTROL,
        }),
      ]),
    );

    let confirmedNow = false;
    let superseded: Array<{
      objectKey: string;
      cardObjectKey: string | null;
      largeObjectKey: string | null;
    }> = [];
    await this.repository.transaction(async (tx) => {
      await this.repository.lockCustomer(userId, tx);
      const current = (await this.repository.find(photo.id, tx))!;
      if (current.status === 'READY') return;
      await this.repository.markReady(photo.id, keys, tx);
      superseded = await this.repository.removeSuperseded(userId, photo.id, tx);
      await this.audit.record(
        {
          action: 'customer.photo_confirm',
          entityType: 'customer_profile_photo',
          entityId: photo.id,
          actorId: userId,
          metadata: {
            originalBytes: object.bytes.length,
            cardBytes: renditions.card.length,
            largeBytes: renditions.large.length,
            replacedPhotos: superseded.length,
          },
        },
        tx,
      );
      confirmedNow = true;
    });
    if (confirmedNow) {
      // The original may carry the phone's GPS position and nothing serves it; a replaced photo is not kept either (best effort).
      const stale = [
        photo.objectKey,
        ...superseded.flatMap((p) => [p.objectKey, p.cardObjectKey, p.largeObjectKey]),
      ].filter((key): key is string => Boolean(key));
      await Promise.all(
        stale.map((key) =>
          this.storage.deleteObject(key).catch(() => {
            this.logger.warn(`Could not remove a stale object of customer photo ${photo.id}`);
          }),
        ),
      );
    }
    return { photoId, status: 'READY' };
  }

  /** The signed-in customer's own current photo, or 404 when there is none. */
  async getMine(userId: string): Promise<PhotoLink> {
    const photo = await this.repository.current(userId);
    if (!photo?.cardObjectKey || !photo.largeObjectKey) throw this.notFound();
    const cardKey = photo.cardObjectKey;
    const largeKey = photo.largeObjectKey;
    const ttlSeconds = this.config.profilePhoto.signedUrlTtlSeconds;
    const [card, large] = await this.storageCall(() =>
      Promise.all([
        this.storage.createDownloadUrl({ objectKey: cardKey, ttlSeconds }),
        this.storage.createDownloadUrl({ objectKey: largeKey, ttlSeconds }),
      ]),
    );
    return {
      url: card.url,
      largeUrl: large.url,
      expiresAt: card.expiresAt < large.expiresAt ? card.expiresAt : large.expiresAt,
      cacheKey: photo.id,
    };
  }

  /** Worker loop: deletes the objects and rows of uploads never confirmed within `olderThanMs`. Returns how many were discarded. */
  async purgeAbandonedUploads(olderThanMs: number, limit = 50): Promise<number> {
    const rows = await this.repository.findAbandoned(new Date(Date.now() - olderThanMs), limit);
    let purged = 0;
    for (const row of rows) {
      try {
        await this.storage.deleteObject(row.objectKey);
        if (await this.repository.deletePending(row.id)) {
          await this.audit.record({
            action: 'customer.photo_abandoned_purged',
            entityType: 'customer_profile_photo',
            entityId: row.id,
            actorId: null,
            metadata: { reason: 'ABANDONED' },
          });
          purged++;
        }
      } catch (error) {
        this.logger.warn(`Abandoned customer photo not discarded: ${(error as Error).message}`);
      }
    }
    return purged;
  }

  private async scan(userId: string, photoId: string, bytes: Buffer): Promise<void> {
    const verdict = await this.scanner.scan(bytes).catch((error: unknown) => {
      this.logger.error(`Malware scan unavailable: ${(error as Error).message}`);
      throw new DomainException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'The image could not be checked right now: try confirming again shortly',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    });
    if (verdict.clean) return;
    await this.audit.record({
      action: 'customer.photo_malware_rejected',
      entityType: 'customer_profile_photo',
      entityId: photoId,
      actorId: userId,
      metadata: { signature: verdict.signature ?? null },
    });
    throw new DomainException(
      PhotoErrorCode.PHOTO_MALWARE_DETECTED,
      'The uploaded file was rejected by the security check',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private async contentRejected(userId: string, photoId: string): Promise<DomainException> {
    await this.audit.record({
      action: 'customer.photo_content_rejected',
      entityType: 'customer_profile_photo',
      entityId: photoId,
      actorId: userId,
      metadata: {},
    });
    return new DomainException(
      PhotoErrorCode.PHOTO_CONTENT_MISMATCH,
      'The uploaded file is not of the declared type',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private notUploaded(): DomainException {
    return new DomainException(
      PhotoErrorCode.PHOTO_NOT_UPLOADED,
      'The image has not been uploaded, or its size does not match',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private limit(): number {
    const maxBytes = this.config.profilePhoto.maxBytes;
    if (maxBytes === undefined) {
      throw new DomainException(
        PhotoErrorCode.PHOTO_NOT_CONFIGURED,
        'Profile photo upload is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return maxBytes;
  }

  private notFound(): DomainException {
    return new DomainException(
      PhotoErrorCode.PHOTO_NOT_FOUND,
      'Photo not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private async storageCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new DomainException(
          PhotoErrorCode.STORAGE_NOT_CONFIGURED,
          'Image storage is not available',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }
}
