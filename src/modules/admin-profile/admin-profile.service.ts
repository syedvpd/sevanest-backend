import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import {
  makeRenditions,
  RENDITION_CACHE_CONTROL,
  RENDITION_CONTENT_TYPE,
  renditionKeys,
  UnreadableImageError,
  type Renditions,
} from '../../common/media/photo-renditions';
import { AppConfigService } from '../../config/app-config.service';
import { MALWARE_SCANNER, type MalwareScanner } from '../../integrations/malware/malware-scanner';
import { ProviderError } from '../../integrations/provider-error';
import {
  detectImageType,
  IMAGE_CONTENT_TYPES,
  validateContent,
} from '../../integrations/storage/file-signature';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../integrations/storage/storage-provider.interface';
import { UsersRepository } from '../users/users.repository';
import { AdminProfileErrorCode } from './admin-profile.errors';
import { AdminProfileRepository } from './admin-profile.repository';
import type {
  AdminProfilePhotoView,
  AdminProfileView,
  UpdateAdminProfileDto,
} from './dto/admin-profile.dto';

/** The subset of Multer's memory-storage file this module uses. The project has no `@types/multer`. */
export interface UploadedImage {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Technical upload ceiling, above the business limit: Multer refuses a body larger than this before it is buffered, so a
 * request cannot exhaust memory whatever PROFILE_PHOTO_MAX_BYTES says. The configured business limit (default 5 MB) is
 * enforced separately and yields the documented 413.
 */
export const ADMIN_PHOTO_TRANSPORT_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * The signed-in admin's own profile ("My Account"). The account id always comes from the access token; no endpoint in
 * this module accepts a target user id, so one admin cannot address another admin's profile. Name, e-mail, phone and
 * photo are the only writable data: role, permissions, status, password and provider identifiers are not reachable from
 * here (the DTO is the allow-list).
 *
 * Photo upload is a direct multipart upload: the bytes are checked against their real signature, decoded and re-encoded
 * to WebP renditions on the server (so EXIF/GPS never leave the server), written to private storage under
 * server-generated keys, and only then referenced from the profile row. A failed write or a failed database update
 * leaves the previous photo untouched and removes anything already written.
 */
@Injectable()
export class AdminProfileService {
  private readonly logger = new Logger(AdminProfileService.name);

  constructor(
    private readonly repository: AdminProfileRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  async getMine(userId: string): Promise<AdminProfileView> {
    return this.view(userId);
  }

  async update(userId: string, dto: UpdateAdminProfileDto): Promise<AdminProfileView> {
    const changed: string[] = [];
    if (dto.fullName !== undefined) changed.push('fullName');
    if (dto.email !== undefined) changed.push('email');
    if (dto.phoneNumber !== undefined) changed.push('phoneNumber');
    if (changed.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'body', messages: ['supply at least one of fullName, email, phoneNumber'] }],
      );
    }

    if (dto.email !== undefined) {
      if (await this.users.findByEmailExcept(dto.email, userId)) throw this.emailTaken();
    }
    if (dto.phoneNumber !== undefined) {
      if (await this.users.findByMobileExcept(dto.phoneNumber, userId)) throw this.phoneTaken();
    }

    try {
      await this.repository.transaction(async (tx) => {
        await this.repository.lockUser(userId, tx);
        if (dto.fullName !== undefined) {
          await this.repository.ensure(userId, tx);
          await this.repository.update(userId, { fullName: dto.fullName }, tx);
        }
        if (dto.email !== undefined || dto.phoneNumber !== undefined) {
          await this.users.updateContact(userId, { email: dto.email, mobile: dto.phoneNumber }, tx);
        }
        await this.audit.record(
          {
            action: 'admin.profile_update',
            entityType: 'admin_profile',
            entityId: userId,
            actorId: userId,
            metadata: { changedFields: changed },
          },
          tx,
        );
      });
    } catch (error) {
      throw this.uniqueConflict(error) ?? error;
    }

    return this.view(userId);
  }

  async uploadPhoto(userId: string, file: UploadedImage | undefined): Promise<AdminProfileView> {
    const maxBytes = this.limit();
    if (!file || file.size === 0 || file.buffer.length === 0) throw this.photoRequired();
    if (file.size > maxBytes) {
      throw new DomainException(
        ErrorCode.PAYLOAD_TOO_LARGE,
        'The image is larger than allowed',
        HttpStatus.PAYLOAD_TOO_LARGE,
        [{ field: 'file', messages: [`at most ${maxBytes} bytes`] }],
      );
    }

    // The declared type is a hint only: the bytes decide what the file is.
    const actualType = detectImageType(file.buffer);
    if (!actualType) {
      throw new DomainException(
        AdminProfileErrorCode.PHOTO_TYPE_NOT_ALLOWED,
        'This image type is not accepted',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'file', messages: [`accepted types: ${IMAGE_CONTENT_TYPES.join(', ')}`] }],
      );
    }
    if (file.mimetype && file.mimetype.toLowerCase() !== actualType) {
      throw new DomainException(
        AdminProfileErrorCode.PHOTO_CONTENT_MISMATCH,
        'The uploaded file is not of the declared type',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'file', messages: [`the content is ${actualType}`] }],
      );
    }
    if (!validateContent(actualType, file.buffer).ok) {
      throw new DomainException(
        AdminProfileErrorCode.PHOTO_CONTENT_MISMATCH,
        'The uploaded file is not of the declared type',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (this.scanner.enabled) await this.scan(userId, file.buffer);

    let renditions: Renditions;
    try {
      renditions = await makeRenditions(file.buffer);
    } catch (error) {
      if (error instanceof UnreadableImageError) {
        throw new DomainException(
          AdminProfileErrorCode.PHOTO_INVALID,
          'The image could not be read',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw error;
    }

    const keys = renditionKeys(`admin-photos/${userId}/${randomUUID()}`);
    const written = [keys.card, keys.large];
    try {
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
    } catch (error) {
      await this.discard(written);
      throw error;
    }

    let previous: { card: string | null; large: string | null } = { card: null, large: null };
    try {
      await this.repository.transaction(async (tx) => {
        await this.repository.lockUser(userId, tx);
        const before = await this.repository.ensure(userId, tx);
        previous = { card: before.photoCardKey, large: before.photoLargeKey };
        await this.repository.update(
          userId,
          { photoCardKey: keys.card, photoLargeKey: keys.large },
          tx,
        );
        await this.audit.record(
          {
            action: 'admin.profile_photo_update',
            entityType: 'admin_profile',
            entityId: userId,
            actorId: userId,
            metadata: {
              sourceBytes: file.size,
              sourceType: actualType,
              cardBytes: renditions.card.length,
              largeBytes: renditions.large.length,
              replaced: previous.card !== null,
            },
          },
          tx,
        );
      });
    } catch (error) {
      // The profile row still points at the old (or no) photo, so the new objects must not linger.
      await this.discard(written);
      throw error;
    }

    await this.discard(
      [previous.card, previous.large].filter((key): key is string => Boolean(key)),
    );
    return this.view(userId);
  }

  // --- internals -----------------------------------------------------------------------------------------------

  private async view(userId: string): Promise<AdminProfileView> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Account not found', HttpStatus.NOT_FOUND);
    }
    const [profile, roles] = await Promise.all([
      this.repository.find(userId),
      this.users.roleCodesOf(userId),
    ]);
    const photo = await this.photoLink(profile?.photoCardKey, profile?.photoLargeKey);
    const updatedAt =
      profile && profile.updatedAt > user.updatedAt ? profile.updatedAt : user.updatedAt;
    return {
      id: user.id,
      fullName: profile?.fullName ?? null,
      email: user.email,
      phoneNumber: user.mobile,
      role: roles[0] ?? null,
      roles,
      status: user.status,
      photo,
      createdAt: user.createdAt,
      updatedAt,
    };
  }

  private async photoLink(
    cardKey: string | null | undefined,
    largeKey: string | null | undefined,
  ): Promise<AdminProfilePhotoView | null> {
    if (!cardKey || !largeKey) return null;
    const ttlSeconds = this.config.profilePhoto.signedUrlTtlSeconds;
    const [card, large] = await this.storageCall(() =>
      Promise.all([
        this.storage.createDownloadUrl({
          objectKey: cardKey,
          ttlSeconds,
          contentType: RENDITION_CONTENT_TYPE,
        }),
        this.storage.createDownloadUrl({
          objectKey: largeKey,
          ttlSeconds,
          contentType: RENDITION_CONTENT_TYPE,
        }),
      ]),
    );
    return {
      url: card.url,
      largeUrl: large.url,
      expiresAt: card.expiresAt < large.expiresAt ? card.expiresAt : large.expiresAt,
      cacheKey: cardKey,
    };
  }

  private async scan(userId: string, bytes: Buffer): Promise<void> {
    const verdict = await this.scanner.scan(bytes).catch((error: unknown) => {
      this.logger.error(`Malware scan unavailable: ${(error as Error).message}`);
      throw new DomainException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'The image could not be checked right now: try again shortly',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    });
    if (verdict.clean) return;
    await this.audit.record({
      action: 'admin.profile_photo_malware_rejected',
      entityType: 'admin_profile',
      entityId: userId,
      actorId: userId,
      metadata: { signature: verdict.signature ?? null },
    });
    throw new DomainException(
      AdminProfileErrorCode.PHOTO_MALWARE_DETECTED,
      'The uploaded file was rejected by the security check',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  /** Best effort: a storage outage must not turn an already-committed profile into a failed request. */
  private async discard(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map((key) =>
        this.storage.deleteObject(key).catch(() => {
          this.logger.warn('Could not remove a stale admin profile photo object');
        }),
      ),
    );
  }

  private limit(): number {
    const maxBytes = this.config.profilePhoto.maxBytes;
    if (maxBytes === undefined) {
      throw new DomainException(
        AdminProfileErrorCode.PHOTO_NOT_CONFIGURED,
        'Profile photo upload is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return maxBytes;
  }

  private async storageCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new DomainException(
          AdminProfileErrorCode.PHOTO_STORAGE_UNAVAILABLE,
          'Image storage is not available',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }

  /** A concurrent request may win the uniqueness race between the pre-check and the write. */
  private uniqueConflict(error: unknown): DomainException | null {
    if (!isUniqueViolation(error)) return null;
    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    const fields = (Array.isArray(target) ? target : [target]).map((field) => String(field ?? ''));
    if (fields.some((field) => field.includes('email'))) return this.emailTaken();
    if (fields.some((field) => field.includes('mobile'))) return this.phoneTaken();
    return new DomainException(
      ErrorCode.CONFLICT,
      'The value is already in use',
      HttpStatus.CONFLICT,
    );
  }

  private emailTaken(): DomainException {
    return new DomainException(
      AdminProfileErrorCode.EMAIL_TAKEN,
      'That e-mail address is already in use',
      HttpStatus.CONFLICT,
      [{ field: 'email', messages: ['already in use by another account'] }],
    );
  }

  private phoneTaken(): DomainException {
    return new DomainException(
      AdminProfileErrorCode.PHONE_TAKEN,
      'That phone number is already in use',
      HttpStatus.CONFLICT,
      [{ field: 'phoneNumber', messages: ['already in use by another account'] }],
    );
  }

  private photoRequired(): DomainException {
    return new DomainException(
      AdminProfileErrorCode.PHOTO_REQUIRED,
      'A file is required in the "file" field',
      HttpStatus.UNPROCESSABLE_ENTITY,
      [{ field: 'file', messages: ['required'] }],
    );
  }
}
