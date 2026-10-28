import { assertIfMatch } from '../../common/concurrency/if-match';
import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, PageQueryDto, skipFor } from '../../common/pagination/pagination';
import { changedFieldNames } from '../../common/validation/fields';
import { MALWARE_SCANNER, type MalwareScanner } from '../../integrations/malware/malware-scanner';
import { matchesDeclaredType, SIGNATURE_BYTES } from '../../integrations/storage/file-signature';
import {
  PUBLIC_KEY_PREFIX,
  PUBLIC_MEDIA_STORAGE,
  type PublicMediaStorage,
} from '../../integrations/storage/public-media.storage';
import {
  makeRenditions,
  RENDITION_CONTENT_TYPE,
  renditionKeys,
  UnreadableImageError,
} from '../worker-photo/photo-renditions';
import type { Actor } from '../users/users.types';
import { CategoryRecord, ServiceCategoriesRepository } from './service-categories.repository';
import {
  AdminCategoryListQuery,
  AdminServiceCategoryResponse,
  CategoryImageLinks,
  CreateServiceCategoryDto,
  ServiceCategoryResponse,
  UpdateServiceCategoryDto,
} from './dto/categories.dto';

export const CategoryErrorCode = {
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  CATEGORY_DUPLICATE: 'CATEGORY_DUPLICATE',
  CATEGORY_NOT_AVAILABLE: 'CATEGORY_NOT_AVAILABLE',
  ENGAGEMENT_NOT_OFFERED: 'ENGAGEMENT_NOT_OFFERED',
  IMAGE_NOT_CONFIGURED: 'IMAGE_NOT_CONFIGURED',
  IMAGE_TYPE_NOT_ALLOWED: 'IMAGE_TYPE_NOT_ALLOWED',
  IMAGE_CONTENT_MISMATCH: 'IMAGE_CONTENT_MISMATCH',
  IMAGE_MALWARE_DETECTED: 'IMAGE_MALWARE_DETECTED',
} as const;

export const CATEGORY_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png'];
/** Technical bound (not a business rule) for an admin-uploaded category image. */
export const CATEGORY_IMAGE_MAX_BYTES = 5_242_880;

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
}

function imageOf(category: CategoryRecord, media: PublicMediaStorage): CategoryImageLinks | null {
  if (!category.imageKey || !media.enabled) return null;
  const keys = renditionKeys(category.imageKey);
  return {
    url: media.urlFor(keys.card),
    largeUrl: media.urlFor(keys.large),
    cacheKey: category.imageKey.slice(category.imageKey.lastIndexOf('/') + 1),
  };
}

function toPublic(
  category: CategoryRecord,
  media: PublicMediaStorage,
  allowed: string[] = [],
): ServiceCategoryResponse {
  return {
    image: imageOf(category, media),
    allowedEngagements: allowed,
    engagements: allowed,
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
  };
}

function toAdmin(
  category: CategoryRecord,
  media: PublicMediaStorage,
  allowed: string[] = [],
): AdminServiceCategoryResponse {
  return {
    ...toPublic(category, media, allowed),
    isEnabled: category.isEnabled,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

/**
 * Service category master (FRD FM-16, SRS FR-ADM-005): stored in PostgreSQL, never hard-coded; unique code and name;
 * enabled/disabled instead of deletion. Customers and workers see enabled categories only. Other modules consume
 * `findByIds` and `assertAssignable`; they never read the table.
 */
@Injectable()
export class ServiceCategoriesService {
  private readonly logger = new Logger(ServiceCategoriesService.name);

  constructor(
    private readonly repository: ServiceCategoriesRepository,
    private readonly audit: AuditService,
    @Inject(PUBLIC_MEDIA_STORAGE) private readonly publicMedia: PublicMediaStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  // --- consumers (customers, workers) -----------------------------------------------------------------------

  async listEnabled(query: PageQueryDto): Promise<Page<ServiceCategoryResponse>> {
    const { items, total } = await this.repository.list(
      { enabled: true },
      skipFor(query),
      query.limit,
    );
    const allowed = await this.repository.engagementsOf(items.map((c) => c.id));
    return {
      data: items.map((c) => toPublic(c, this.publicMedia, allowed.get(c.id))),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async getEnabled(id: string): Promise<ServiceCategoryResponse> {
    const category = await this.repository.findById(id);
    if (!category || !category.isEnabled) {
      throw this.notFound();
    }
    return toPublic(
      category,
      this.publicMedia,
      (await this.repository.engagementsOf([id])).get(id),
    );
  }

  // --- contract for other modules ---------------------------------------------------------------------------

  findByIds(ids: string[]): Promise<CategoryRecord[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.repository.findByIds(ids);
  }

  /**
   * PRD 4: a category offers only some engagement types. When the administrator has configured the list, any other engagement is
   * refused (422); a category with no list is unrestricted. One check for booking, search and matching.
   */
  async assertEngagementOffered(
    categoryId: string,
    engagement: string,
    field = 'engagement',
  ): Promise<void> {
    const allowed = (await this.repository.engagementsOf([categoryId])).get(categoryId);
    if (allowed && !allowed.includes(engagement)) {
      throw new DomainException(
        CategoryErrorCode.ENGAGEMENT_NOT_OFFERED,
        'This category is not offered with that engagement type',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field, messages: [`allowed for this category: ${allowed.join(', ')}`] }],
      );
    }
  }

  /** Replaces the allowed engagement types of a category (empty = unrestricted). Audited with before and after. */
  async adminSetEngagements(
    id: string,
    engagements: string[],
    actor: Actor & { userId: string },
  ): Promise<AdminServiceCategoryResponse> {
    const unique = [...new Set(engagements)].sort();
    await this.repository.transaction(async (tx) => {
      const category = await this.repository.lockById(id, tx);
      if (!category) throw this.notFound();
      const before = (await this.repository.engagementsOf([id], tx)).get(id) ?? [];
      await this.repository.replaceEngagements(id, unique, tx);
      if (JSON.stringify(before) !== JSON.stringify(unique)) {
        await this.audit.record(
          {
            action: 'service_category.engagements_set',
            entityType: 'service_category',
            entityId: id,
            actorId: actor.userId,
            actorRole: actor.roles.join(',') || null,
            metadata: { code: category.code, from: before, to: unique },
          },
          tx,
        );
      }
    });
    return this.adminGet(id);
  }

  /** A search criterion names a category by its stable code; unknown and disabled answer the same (422). */
  async requireEnabledByCode(code: string, field = 'category'): Promise<CategoryRecord> {
    const category = await this.repository.findByCode(code);
    if (!category || !category.isEnabled) {
      throw new DomainException(
        CategoryErrorCode.CATEGORY_NOT_AVAILABLE,
        'The category is not available',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field, messages: [`${field} is not an enabled category`] }],
      );
    }
    return category;
  }

  /**
   * Checks a requested set of category ids: every id must exist, and every id that is NEW for the caller must be
   * enabled (FM-04: roles are chosen "from enabled categories"). Ids the caller already holds may stay even if the
   * category was disabled later.
   */
  async assertAssignable(
    requested: string[],
    alreadyAssigned: string[],
    field = 'categoryIds',
  ): Promise<CategoryRecord[]> {
    const found = await this.findByIds(requested);
    const byId = new Map(found.map((c) => [c.id, c]));
    const unknown = requested.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field, messages: [`${field} contains an unknown category`] }],
      );
    }
    const held = new Set(alreadyAssigned);
    const unavailable = found.filter((c) => !c.isEnabled && !held.has(c.id));
    if (unavailable.length > 0) {
      throw new DomainException(
        CategoryErrorCode.CATEGORY_NOT_AVAILABLE,
        'One or more categories are not available',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field, messages: [`${field} contains a category that is not enabled`] }],
      );
    }
    return found;
  }

  // --- admin management (permission category.manage; Super Admin in FRD FM-16) ------------------------------

  async adminList(query: AdminCategoryListQuery): Promise<Page<AdminServiceCategoryResponse>> {
    const { items, total } = await this.repository.list(
      { enabled: query.isEnabled },
      skipFor(query),
      query.limit,
    );
    const allowed = await this.repository.engagementsOf(items.map((c) => c.id));
    return {
      data: items.map((c) => toAdmin(c, this.publicMedia, allowed.get(c.id))),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(id: string): Promise<AdminServiceCategoryResponse> {
    const category = await this.repository.findById(id);
    if (!category) {
      throw this.notFound();
    }
    return toAdmin(category, this.publicMedia, (await this.repository.engagementsOf([id])).get(id));
  }

  async adminCreate(
    dto: CreateServiceCategoryDto,
    actor: Actor & { userId: string },
  ): Promise<AdminServiceCategoryResponse> {
    try {
      const created = await this.repository.transaction(async (tx) => {
        const category = await this.repository.create(
          { code: dto.code, name: dto.name, description: dto.description ?? null },
          tx,
        );
        await this.audit.record(
          {
            action: 'service_category.create',
            entityType: 'service_category',
            entityId: category.id,
            actorId: actor.userId,
            actorRole: actor.roles.join(',') || null,
            metadata: { code: category.code, name: category.name },
          },
          tx,
        );
        return category;
      });
      return toAdmin(created, this.publicMedia);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.duplicate();
      }
      throw error;
    }
  }

  async adminUpdate(
    id: string,
    dto: UpdateServiceCategoryDto,
    actor: Actor & { userId: string },
    ifMatch?: string,
  ): Promise<AdminServiceCategoryResponse> {
    const fields = changedFieldNames(dto);
    if (fields.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'body', messages: ['at least one field must be provided'] }],
      );
    }
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const before = await this.repository.lockById(id, tx);
        if (!before) {
          throw this.notFound();
        }
        assertIfMatch(ifMatch, before.updatedAt);
        const after = await this.repository.update(id, dto, tx);
        // Configuration data (not personal data): the audit keeps before and after of the fields that changed.
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const field of fields as Array<'name' | 'description' | 'isEnabled'>) {
          if (before[field] !== after[field]) {
            changes[field] = { from: before[field], to: after[field] };
          }
        }
        if (Object.keys(changes).length > 0) {
          await this.audit.record(
            {
              action: 'service_category.update',
              entityType: 'service_category',
              entityId: id,
              actorId: actor.userId,
              actorRole: actor.roles.join(',') || null,
              metadata: { code: before.code, changes },
            },
            tx,
          );
        }
        return after;
      });
      return toAdmin(updated, this.publicMedia);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.duplicate();
      }
      throw error;
    }
  }

  /**
   * D-91: the admin sets (or replaces) the category image. The server checks the file signature, scans it when a scanner is
   * configured, re-encodes it to two WebP sizes without metadata and stores them in the public bucket under new keys, so
   * the permanent links of the previous image stay valid until it is replaced. The previous files are removed afterwards.
   */
  async adminSetImage(
    id: string,
    file: UploadedImage | undefined,
    actor: Actor & { userId: string },
  ): Promise<AdminServiceCategoryResponse> {
    this.requirePublicMedia();
    if (!file || file.buffer.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'file', messages: ['an image file is required'] }],
      );
    }
    if (!CATEGORY_IMAGE_CONTENT_TYPES.includes(file.mimetype)) {
      throw new DomainException(
        CategoryErrorCode.IMAGE_TYPE_NOT_ALLOWED,
        'This image type is not accepted',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [
          {
            field: 'file',
            messages: [`accepted types: ${CATEGORY_IMAGE_CONTENT_TYPES.join(', ')}`],
          },
        ],
      );
    }
    if (!matchesDeclaredType(file.mimetype, file.buffer.subarray(0, SIGNATURE_BYTES))) {
      throw this.contentMismatch();
    }
    if (this.scanner.enabled) {
      const verdict = await this.scanner.scan(file.buffer).catch((error: unknown) => {
        this.logger.error(`Malware scan unavailable: ${(error as Error).message}`);
        throw new DomainException(
          ErrorCode.SERVICE_UNAVAILABLE,
          'The image could not be checked right now: try again shortly',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      });
      if (!verdict.clean) {
        throw new DomainException(
          CategoryErrorCode.IMAGE_MALWARE_DETECTED,
          'The uploaded file was rejected by the security check',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    let renditions;
    try {
      renditions = await makeRenditions(file.buffer);
    } catch (error) {
      if (error instanceof UnreadableImageError) throw this.contentMismatch();
      throw error;
    }
    const imageKey = `${PUBLIC_KEY_PREFIX}categories/${id}/${randomUUID()}`;
    const keys = renditionKeys(imageKey);
    await this.mediaCall(() =>
      Promise.all([
        this.publicMedia.put(keys.card, renditions.card, RENDITION_CONTENT_TYPE),
        this.publicMedia.put(keys.large, renditions.large, RENDITION_CONTENT_TYPE),
      ]),
    );
    let previous: string | null = null;
    try {
      await this.repository.transaction(async (tx) => {
        const before = await this.repository.lockById(id, tx);
        if (!before) throw this.notFound();
        previous = before.imageKey;
        await this.repository.setImage(id, imageKey, tx);
        await this.audit.record(
          {
            action: 'service_category.image_set',
            entityType: 'service_category',
            entityId: id,
            actorId: actor.userId,
            actorRole: actor.roles.join(',') || null,
            metadata: {
              code: before.code,
              cardBytes: renditions.card.length,
              largeBytes: renditions.large.length,
            },
          },
          tx,
        );
      });
    } catch (error) {
      await this.discardImage(imageKey); // nothing points at the new files
      throw error;
    }
    await this.discardImage(previous);
    return this.adminGet(id);
  }

  /** Removes the category image (idempotent). */
  async adminRemoveImage(
    id: string,
    actor: Actor & { userId: string },
  ): Promise<AdminServiceCategoryResponse> {
    let previous: string | null = null;
    await this.repository.transaction(async (tx) => {
      const before = await this.repository.lockById(id, tx);
      if (!before) throw this.notFound();
      previous = before.imageKey;
      if (!before.imageKey) return;
      await this.repository.setImage(id, null, tx);
      await this.audit.record(
        {
          action: 'service_category.image_removed',
          entityType: 'service_category',
          entityId: id,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: { code: before.code },
        },
        tx,
      );
    });
    await this.discardImage(previous);
    return this.adminGet(id);
  }

  /** Best effort: a file that cannot be deleted is never served again, it only costs storage. */
  private async discardImage(imageKey: string | null): Promise<void> {
    if (!imageKey || !this.publicMedia.enabled) return;
    const keys = renditionKeys(imageKey);
    await Promise.all([
      this.publicMedia.delete(keys.card),
      this.publicMedia.delete(keys.large),
    ]).catch(() =>
      this.logger.warn(`Could not remove the files of a replaced category image (${imageKey})`),
    );
  }

  private requirePublicMedia(): void {
    if (!this.publicMedia.enabled) {
      throw new DomainException(
        CategoryErrorCode.IMAGE_NOT_CONFIGURED,
        'Public image storage is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async mediaCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch {
      throw new DomainException(
        CategoryErrorCode.IMAGE_NOT_CONFIGURED,
        'Image storage is not available',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private contentMismatch(): DomainException {
    return new DomainException(
      CategoryErrorCode.IMAGE_CONTENT_MISMATCH,
      'The uploaded file is not a readable image of the declared type',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private notFound(): DomainException {
    return new DomainException(
      CategoryErrorCode.CATEGORY_NOT_FOUND,
      'Service category not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private duplicate(): DomainException {
    return new DomainException(
      CategoryErrorCode.CATEGORY_DUPLICATE,
      'A category with this code or name already exists',
      HttpStatus.CONFLICT,
    );
  }
}
