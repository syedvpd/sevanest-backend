import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, PageQueryDto, skipFor } from '../../common/pagination/pagination';
import { changedFieldNames } from '../../common/validation/fields';
import type { Actor } from '../users/users.types';
import { CategoryRecord, ServiceCategoriesRepository } from './service-categories.repository';
import {
  AdminCategoryListQuery,
  AdminServiceCategoryResponse,
  CreateServiceCategoryDto,
  ServiceCategoryResponse,
  UpdateServiceCategoryDto,
} from './dto/categories.dto';

export const CategoryErrorCode = {
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  CATEGORY_DUPLICATE: 'CATEGORY_DUPLICATE',
  CATEGORY_NOT_AVAILABLE: 'CATEGORY_NOT_AVAILABLE',
} as const;

function toPublic(category: CategoryRecord): ServiceCategoryResponse {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
  };
}

function toAdmin(category: CategoryRecord): AdminServiceCategoryResponse {
  return {
    ...toPublic(category),
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
  constructor(
    private readonly repository: ServiceCategoriesRepository,
    private readonly audit: AuditService,
  ) {}

  // --- consumers (customers, workers) -----------------------------------------------------------------------

  async listEnabled(query: PageQueryDto): Promise<Page<ServiceCategoryResponse>> {
    const { items, total } = await this.repository.list(
      { enabled: true },
      skipFor(query),
      query.limit,
    );
    return { data: items.map(toPublic), meta: { page: query.page, limit: query.limit, total } };
  }

  async getEnabled(id: string): Promise<ServiceCategoryResponse> {
    const category = await this.repository.findById(id);
    if (!category || !category.isEnabled) {
      throw this.notFound();
    }
    return toPublic(category);
  }

  // --- contract for other modules ---------------------------------------------------------------------------

  findByIds(ids: string[]): Promise<CategoryRecord[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.repository.findByIds(ids);
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
    return { data: items.map(toAdmin), meta: { page: query.page, limit: query.limit, total } };
  }

  async adminGet(id: string): Promise<AdminServiceCategoryResponse> {
    const category = await this.repository.findById(id);
    if (!category) {
      throw this.notFound();
    }
    return toAdmin(category);
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
      return toAdmin(created);
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
      return toAdmin(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.duplicate();
      }
      throw error;
    }
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
