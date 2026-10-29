import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AppConfigService } from '../../config/app-config.service';
import { MALWARE_SCANNER, type MalwareScanner } from '../../integrations/malware/malware-scanner';
import { ProviderError } from '../../integrations/provider-error';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../integrations/storage/storage-provider.interface';
import { matchesDeclaredType, SIGNATURE_BYTES } from '../../integrations/storage/file-signature';
import {
  isPublicKey,
  PUBLIC_KEY_PREFIX,
  PUBLIC_MEDIA_STORAGE,
  type PublicMediaStorage,
} from '../../integrations/storage/public-media.storage';
import { WorkersService } from '../workers/workers.service';
import type { PhotoLink, PhotoUploadResponse, RequestPhotoUploadDto } from './dto/worker-photo.dto';
import {
  makeRenditions,
  RENDITION_CACHE_CONTROL,
  RENDITION_CONTENT_TYPE,
  renditionKeys,
  UnreadableImageError,
  type Renditions,
} from '../../common/media/photo-renditions';
import { WorkerPhotoRepository } from './worker-photo.repository';

export const PhotoErrorCode = {
  PHOTO_NOT_CONFIGURED: 'PHOTO_NOT_CONFIGURED',
  PHOTO_TYPE_NOT_ALLOWED: 'PHOTO_TYPE_NOT_ALLOWED',
  PHOTO_NOT_FOUND: 'PHOTO_NOT_FOUND',
  PHOTO_NOT_UPLOADED: 'PHOTO_NOT_UPLOADED',
  PHOTO_CONTENT_MISMATCH: 'PHOTO_CONTENT_MISMATCH',
  PHOTO_MALWARE_DETECTED: 'PHOTO_MALWARE_DETECTED',
  TOO_MANY_PENDING_PHOTOS: 'TOO_MANY_PENDING_PHOTOS',
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
} as const;

export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png'];
/** Technical abuse guard (not a business rule): unconfirmed uploads one worker may hold at a time. */
const MAX_PENDING = 5;
/** A public link never expires; `expiresAt` stays in the response for compatibility and is one year ahead, so apps that refresh at expiry just refresh early. */
const PERMANENT_LINK_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Worker profile photo (FR-WON-002, FRD FM-04). Private object storage only; the client uploads to a short-lived signed URL, then
 * confirms. Confirmation checks the real size and the file signature (JPEG/PNG) server-side before the photo becomes current.
 * When a malware scanner is configured (CLAMAV_HOST) the whole image is scanned too, exactly like KYC documents. The size limit is business configuration (PROFILE_PHOTO_MAX_BYTES):
 * until it is set the feature answers 503 rather than guessing one.
 */
@Injectable()
export class WorkerPhotoService {
  private readonly logger = new Logger(WorkerPhotoService.name);

  constructor(
    private readonly repository: WorkerPhotoRepository,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(PUBLIC_MEDIA_STORAGE) private readonly publicMedia: PublicMediaStorage,
  ) {}

  async requestUpload(userId: string, dto: RequestPhotoUploadDto): Promise<PhotoUploadResponse> {
    const maxBytes = this.limit();
    const ref = await this.workers.requireRefByUserId(userId);
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
    const objectKey = `photos/${ref.workerId}/${randomUUID()}`;
    const ttlSeconds = this.config.profilePhoto.signedUrlTtlSeconds;
    const upload = await this.storageCall(() =>
      this.storage.createUploadUrl({
        objectKey,
        contentType: dto.contentType,
        maxBytes: dto.sizeBytes,
        ttlSeconds,
      }),
    );
    const photoId = await this.repository.transaction(async (tx) => {
      await this.repository.lockWorker(ref.workerId, tx);
      if ((await this.repository.countPending(ref.workerId, tx)) >= MAX_PENDING) {
        throw new DomainException(
          PhotoErrorCode.TOO_MANY_PENDING_PHOTOS,
          'Too many images are waiting to be confirmed',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const photo = await this.repository.create(
        {
          workerId: ref.workerId,
          objectKey,
          contentType: dto.contentType,
          sizeBytes: dto.sizeBytes,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'worker.photo_request',
          entityType: 'worker_profile_photo',
          entityId: photo.id,
          actorId: userId,
          metadata: { workerId: ref.workerId, contentType: dto.contentType },
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

  /** Repeating the call for a photo that is already current changes nothing. Another worker's photo answers 404. */
  async confirm(userId: string, photoId: string): Promise<{ photoId: string; status: 'READY' }> {
    const maxBytes = this.limit();
    const ref = await this.workers.requireRefByUserId(userId);
    const photo = await this.repository.find(photoId);
    if (!photo || photo.workerId !== ref.workerId) throw this.notFound();
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
      throw await this.contentRejected(userId, ref.workerId, photo.id);
    }
    const object = await this.storageCall(() => this.storage.readObject(photo.objectKey, maxBytes));
    if (!object || object.truncated) throw this.notUploaded();
    if (this.scanner.enabled) await this.scan(userId, ref.workerId, photo.id, object.bytes);

    // D-69: customers only ever download server-made WebP renditions without camera metadata.
    let renditions: Renditions;
    try {
      renditions = await makeRenditions(object.bytes);
    } catch (error) {
      if (error instanceof UnreadableImageError) {
        throw await this.contentRejected(userId, ref.workerId, photo.id);
      }
      throw error;
    }
    // D-93: with a public bucket configured the renditions get permanent links; otherwise they stay private with signed links.
    const keys = renditionKeys(
      this.publicMedia.enabled ? `${PUBLIC_KEY_PREFIX}${photo.objectKey}` : photo.objectKey,
    );
    await this.storageCall(() =>
      this.publicMedia.enabled
        ? Promise.all([
            this.publicMedia.put(keys.card, renditions.card, RENDITION_CONTENT_TYPE),
            this.publicMedia.put(keys.large, renditions.large, RENDITION_CONTENT_TYPE),
          ])
        : Promise.all([
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
    await this.repository.transaction(async (tx) => {
      await this.repository.lockWorker(ref.workerId, tx);
      const current = (await this.repository.find(photo.id, tx))!;
      if (current.status === 'READY') return;
      await this.repository.markReady(photo.id, keys, tx);
      await this.workers.setPhotoRef(ref.workerId, photo.objectKey, tx);
      await this.audit.record(
        {
          action: 'worker.photo_confirm',
          entityType: 'worker_profile_photo',
          entityId: photo.id,
          actorId: userId,
          metadata: {
            workerId: ref.workerId,
            originalBytes: object.bytes.length,
            cardBytes: renditions.card.length,
            largeBytes: renditions.large.length,
          },
        },
        tx,
      );
      confirmedNow = true;
    });
    if (confirmedNow) {
      // The original may carry the phone's GPS position; nothing serves it any more, so it is removed (best effort).
      await this.storage.deleteObject(photo.objectKey).catch(() => {
        this.logger.warn(`Could not remove the original of photo ${photo.id}; it is never served`);
      });
    }
    return { photoId, status: 'READY' };
  }

  /**
   * Same policy as KYC documents: a scanner that cannot answer leaves the photo unconfirmed (never accepted unscanned) so the
   * worker can retry; a detection is audited and refused.
   */
  private async scan(
    userId: string,
    workerId: string,
    photoId: string,
    bytes: Buffer,
  ): Promise<void> {
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
      action: 'worker.photo_malware_rejected',
      entityType: 'worker_profile_photo',
      entityId: photoId,
      actorId: userId,
      metadata: { workerId, signature: verdict.signature ?? null },
    });
    throw new DomainException(
      PhotoErrorCode.PHOTO_MALWARE_DETECTED,
      'The uploaded file was rejected by the security check',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private async contentRejected(
    userId: string,
    workerId: string,
    photoId: string,
  ): Promise<DomainException> {
    await this.audit.record({
      action: 'worker.photo_content_rejected',
      entityType: 'worker_profile_photo',
      entityId: photoId,
      actorId: userId,
      metadata: { workerId },
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

  /** The signed-in worker's own current photo, or 404 when there is none. */
  async getMine(userId: string): Promise<PhotoLink> {
    const ref = await this.workers.requireRefByUserId(userId);
    const link = (await this.linksFor([ref.workerId])).get(ref.workerId);
    if (!link) throw this.notFound();
    return link;
  }

  /**
   * Contract for customer-facing reads: short-lived links to the CURRENT photo of each given worker. The caller has already
   * decided the workers are visible to the customer. A storage failure yields no link (the profile is still served).
   */
  async linksFor(workerIds: string[]): Promise<Map<string, PhotoLink>> {
    const keys = await this.repository.currentKeys(workerIds);
    const ttlSeconds = this.config.profilePhoto.signedUrlTtlSeconds;
    const links = new Map<string, PhotoLink>();
    await Promise.all(
      [...keys].map(async ([workerId, photo]) => {
        try {
          if (isPublicKey(photo.cardKey) && isPublicKey(photo.largeKey)) {
            links.set(workerId, {
              url: this.publicMedia.urlFor(photo.cardKey),
              largeUrl: this.publicMedia.urlFor(photo.largeKey),
              expiresAt: new Date(Date.now() + PERMANENT_LINK_MS),
              cacheKey: photo.photoId,
            });
            return;
          }
          const [card, large] = await Promise.all([
            this.storage.createDownloadUrl({ objectKey: photo.cardKey, ttlSeconds }),
            this.storage.createDownloadUrl({ objectKey: photo.largeKey, ttlSeconds }),
          ]);
          links.set(workerId, {
            url: card.url,
            largeUrl: large.url,
            expiresAt: card.expiresAt < large.expiresAt ? card.expiresAt : large.expiresAt,
            cacheKey: photo.photoId,
          });
        } catch (error) {
          this.logger.warn(
            `Could not sign a photo link: ${error instanceof ProviderError ? 'storage unavailable' : 'unexpected error'}`,
          );
        }
      }),
    );
    return links;
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
