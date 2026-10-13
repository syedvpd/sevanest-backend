import { assertIfMatch } from '../../common/concurrency/if-match';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, skipFor } from '../../common/pagination/pagination';
import { changedFieldNames } from '../../common/validation/fields';
import type { Actor } from '../users/users.types';
import { AreaRecord, AvailabilityRepository } from './availability.repository';
import {
  AdminServiceAreaListQuery,
  AdminServiceAreaResponse,
  CreateServiceAreaDto,
  ResolveAreaQuery,
  ServiceAreaListQuery,
  ServiceAreaResponse,
  UpdateServiceAreaDto,
} from './dto/availability.dto';

export const AreaErrorCode = {
  AREA_NOT_FOUND: 'AREA_NOT_FOUND',
  AREA_DUPLICATE: 'AREA_DUPLICATE',
  AREA_NOT_AVAILABLE: 'AREA_NOT_AVAILABLE',
} as const;

export function toPublicArea(area: AreaRecord): ServiceAreaResponse {
  return { id: area.id, name: area.name, city: area.city };
}

function toAdminArea(area: AreaRecord): AdminServiceAreaResponse {
  return {
    ...toPublicArea(area),
    isEnabled: area.isEnabled,
    centerLatitude: area.centerLatitude,
    centerLongitude: area.centerLongitude,
    radiusMeters: area.radiusMeters,
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
  };
}

/**
 * Service area master (FRD FM-16: "Unique within the city; enabled/disabled"). No areas are seeded: the specifications name
 * pilot localities only as launch planning, so an admin creates the areas. Ownership of config masters is open (Q-14).
 */
@Injectable()
export class ServiceAreasService {
  constructor(
    private readonly repository: AvailabilityRepository,
    private readonly audit: AuditService,
  ) {}

  async listEnabled(query: ServiceAreaListQuery): Promise<Page<ServiceAreaResponse>> {
    const { items, total } = await this.repository.listAreas(
      { enabled: true, city: query.city },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map(toPublicArea),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /**
   * Map a device position (and/or a geocoder's area name) to an enabled service area. A position wins when some area's circle covers it
   * (nearest centre); otherwise an exact, case-insensitive name match is used. 404 AREA_NOT_FOUND when nothing matches: the customer
   * then chooses an area from the list.
   */
  async resolve(query: ResolveAreaQuery): Promise<ServiceAreaResponse> {
    const hasPoint = query.latitude !== undefined && query.longitude !== undefined;
    if (
      (query.latitude === undefined) !== (query.longitude === undefined) ||
      (!hasPoint && !query.name)
    ) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'latitude', messages: ['send latitude with longitude, and/or name'] }],
      );
    }
    const byPoint = hasPoint
      ? await this.repository.findAreaCovering(
          query.latitude as number,
          query.longitude as number,
          query.city,
        )
      : null;
    const area =
      byPoint ??
      (query.name ? await this.repository.findEnabledAreaByName(query.name, query.city) : null);
    if (!area) {
      throw this.notFound();
    }
    return toPublicArea(area);
  }

  async getEnabled(id: string): Promise<ServiceAreaResponse> {
    const area = await this.repository.findAreaById(id);
    if (!area || !area.isEnabled) {
      throw this.notFound();
    }
    return toPublicArea(area);
  }

  /** Contract for Booking and Search read models: areas by id (enabled or not). */
  findByIds(ids: string[]): Promise<AreaRecord[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.repository.findAreasByIds(ids);
  }

  /** A search criterion names one area; unknown and disabled answer the same (422): "location outside enabled areas". */
  async requireEnabled(id: string, field = 'areaId'): Promise<AreaRecord> {
    const area = await this.repository.findAreaById(id);
    if (!area || !area.isEnabled) {
      throw new DomainException(
        AreaErrorCode.AREA_NOT_AVAILABLE,
        'The location is not in an enabled service area',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field, messages: [`${field} is not an enabled service area`] }],
      );
    }
    return area;
  }

  /** Every id must exist; every id NEW for the worker must be enabled (FM-04: "Enabled service areas"). */
  async assertAssignable(
    requested: string[],
    alreadyAssigned: string[],
    field = 'areaIds',
  ): Promise<void> {
    const found = await this.repository.findAreasByIds(requested);
    const known = new Set(found.map((a) => a.id));
    if (requested.some((id) => !known.has(id))) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field, messages: [`${field} contains an unknown area`] }],
      );
    }
    const held = new Set(alreadyAssigned);
    if (found.some((a) => !a.isEnabled && !held.has(a.id))) {
      throw new DomainException(
        AreaErrorCode.AREA_NOT_AVAILABLE,
        'One or more areas are not available',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field, messages: [`${field} contains an area that is not enabled`] }],
      );
    }
  }

  // --- admin (permission area.manage) -----------------------------------------------------------------------

  async adminList(query: AdminServiceAreaListQuery): Promise<Page<AdminServiceAreaResponse>> {
    const { items, total } = await this.repository.listAreas(
      { enabled: query.isEnabled, city: query.city },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map(toAdminArea),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(id: string): Promise<AdminServiceAreaResponse> {
    const area = await this.repository.findAreaById(id);
    if (!area) {
      throw this.notFound();
    }
    return toAdminArea(area);
  }

  async adminCreate(
    dto: CreateServiceAreaDto,
    actor: Actor & { userId: string },
  ): Promise<AdminServiceAreaResponse> {
    this.assertGeoComplete(
      dto.centerLatitude ?? null,
      dto.centerLongitude ?? null,
      dto.radiusMeters ?? null,
    );
    try {
      const created = await this.repository.transaction(async (tx) => {
        const area = await this.repository.createArea(
          {
            name: dto.name,
            city: dto.city,
            centerLatitude: dto.centerLatitude ?? null,
            centerLongitude: dto.centerLongitude ?? null,
            radiusMeters: dto.radiusMeters ?? null,
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'service_area.create',
            entityType: 'service_area',
            entityId: area.id,
            actorId: actor.userId,
            actorRole: actor.roles.join(',') || null,
            metadata: { name: area.name, city: area.city },
          },
          tx,
        );
        return area;
      });
      return toAdminArea(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.duplicate();
      }
      throw error;
    }
  }

  async adminUpdate(
    id: string,
    dto: UpdateServiceAreaDto,
    actor: Actor & { userId: string },
    ifMatch?: string,
  ): Promise<AdminServiceAreaResponse> {
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
        const before = await this.repository.lockArea(id, tx);
        if (!before) {
          throw this.notFound();
        }
        assertIfMatch(ifMatch, before.updatedAt);
        this.assertGeoComplete(
          dto.centerLatitude === undefined ? before.centerLatitude : dto.centerLatitude,
          dto.centerLongitude === undefined ? before.centerLongitude : dto.centerLongitude,
          dto.radiusMeters === undefined ? before.radiusMeters : dto.radiusMeters,
        );
        const after = await this.repository.updateArea(id, dto, tx);
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const field of fields as Array<
          'name' | 'city' | 'isEnabled' | 'centerLatitude' | 'centerLongitude' | 'radiusMeters'
        >) {
          if (before[field] !== after[field]) {
            changes[field] = { from: before[field], to: after[field] };
          }
        }
        if (Object.keys(changes).length > 0) {
          await this.audit.record(
            {
              action: 'service_area.update',
              entityType: 'service_area',
              entityId: id,
              actorId: actor.userId,
              actorRole: actor.roles.join(',') || null,
              metadata: { changes },
            },
            tx,
          );
        }
        return after;
      });
      return toAdminArea(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.duplicate();
      }
      throw error;
    }
  }

  /** A centre needs latitude, longitude and radius together; all three may be null. */
  private assertGeoComplete(lat: number | null, lng: number | null, radius: number | null): void {
    const set = [lat, lng, radius].filter((v) => v !== null).length;
    if (set !== 0 && set !== 3) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'centerLatitude',
            messages: ['centerLatitude, centerLongitude and radiusMeters go together'],
          },
        ],
      );
    }
  }

  private notFound(): DomainException {
    return new DomainException(
      AreaErrorCode.AREA_NOT_FOUND,
      'Service area not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private duplicate(): DomainException {
    return new DomainException(
      AreaErrorCode.AREA_DUPLICATE,
      'This area already exists in the city',
      HttpStatus.CONFLICT,
    );
  }
}
