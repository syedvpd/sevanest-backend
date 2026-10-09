import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { changedFieldNames } from '../../common/validation/fields';
import type { Actor } from '../users/users.types';
import { WorkerSubmissionRegistry } from '../workers/worker-submission.registry';
import { WorkersService } from '../workers/workers.service';
import { AvailabilityRepository, WorkerAvailabilityRecord } from './availability.repository';
import { UpdateAvailabilityDto, WorkerAvailabilityResponse } from './dto/availability.dto';
import { normaliseTimeWindows, toText } from './domain/time-windows';
import { ServiceAreasService } from './service-areas.service';

export type AvailabilityActor =
  { kind: 'self'; userId: string } | { kind: 'admin'; actor: Actor & { userId: string } };

function toResponse(record: WorkerAvailabilityRecord): WorkerAvailabilityResponse {
  return {
    engagementPreference: record.engagementPreference,
    areas: record.areas.map((a) => ({
      id: a.id,
      name: a.name,
      city: a.city,
      isEnabled: a.isEnabled,
    })),
    timeWindows: record.windows.map((w) => ({
      start: toText(w.startMinute),
      end: toText(w.endMinute),
    })),
  };
}

/**
 * Worker availability (FR-WP-003/005/006): engagement preference, preferred service areas and daily time windows.
 * Windows are minutes after local midnight, [start, end), one timezone (India); the specifications define no weekdays,
 * effective dates or overnight windows, so none are modelled (open decisions).
 * Search/Matching will query `worker_preferred_areas` (by area) and `worker_time_windows` (by minute range) directly
 * through this module's contract; those indexes are documented in the module README.
 */
@Injectable()
export class AvailabilityService implements OnModuleInit {
  constructor(
    private readonly repository: AvailabilityRepository,
    private readonly areas: ServiceAreasService,
    private readonly workers: WorkersService,
    private readonly registry: WorkerSubmissionRegistry,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    // FM-04 marks preferred locations, available timings and the engagement preference as mandatory for submission.
    this.registry.register({
      missingFor: async (workerId) => {
        const summary = await this.repository.summary(workerId);
        const missing: string[] = [];
        if (summary.areaCount === 0) missing.push('areas');
        if (summary.windowCount === 0) missing.push('timeWindows');
        if (!summary.hasPreference) missing.push('engagementPreference');
        return missing;
      },
    });
  }

  async getMine(userId: string): Promise<WorkerAvailabilityResponse> {
    const ref = await this.workers.requireRefByUserId(userId);
    return toResponse(await this.repository.get(ref.workerId));
  }

  async updateMine(
    userId: string,
    dto: UpdateAvailabilityDto,
  ): Promise<WorkerAvailabilityResponse> {
    const ref = await this.workers.requireRefByUserId(userId);
    return this.update(ref.workerId, dto, { kind: 'self', userId });
  }

  async adminGet(workerId: string): Promise<WorkerAvailabilityResponse> {
    await this.workers.requireRefById(workerId);
    return toResponse(await this.repository.get(workerId));
  }

  async adminUpdate(
    workerId: string,
    dto: UpdateAvailabilityDto,
    actor: Actor & { userId: string },
  ): Promise<WorkerAvailabilityResponse> {
    await this.workers.requireRefById(workerId);
    return this.update(workerId, dto, { kind: 'admin', actor });
  }

  private async update(
    workerId: string,
    dto: UpdateAvailabilityDto,
    by: AvailabilityActor,
  ): Promise<WorkerAvailabilityResponse> {
    const parts = changedFieldNames(dto);
    if (parts.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'body', messages: ['at least one field must be provided'] }],
      );
    }
    // Pure validation first: nothing touches the database for an invalid or overlapping set of windows.
    const windows = dto.timeWindows ? normaliseTimeWindows(dto.timeWindows) : undefined;

    return this.repository.transaction(async (tx) => {
      await this.repository.lockWorker(workerId, tx);

      const metadata: Record<string, unknown> = { changedParts: parts };
      if (dto.engagementPreference !== undefined) {
        metadata.engagementPreference = {
          from: await this.repository.currentPreference(workerId, tx),
          to: dto.engagementPreference,
        };
        await this.repository.setPreference(workerId, dto.engagementPreference, tx);
      }
      if (dto.areaIds) {
        const current = await this.repository.preferredAreaIds(workerId, tx);
        await this.areas.assertAssignable(dto.areaIds, current);
        const wanted = new Set(dto.areaIds);
        const held = new Set(current);
        const added = dto.areaIds.filter((id) => !held.has(id));
        const removed = current.filter((id) => !wanted.has(id));
        await this.repository.removeAreas(workerId, removed, tx);
        await this.repository.addAreas(workerId, added, tx);
        metadata.areas = { added, removed };
      }
      if (windows) {
        const before = await this.repository.currentWindows(workerId, tx);
        await this.repository.replaceWindows(workerId, windows, tx);
        metadata.timeWindows = { before: before.length, after: windows.length };
      }
      await this.audit.record(
        {
          action: 'availability.update',
          entityType: 'worker_availability',
          entityId: workerId,
          actorId: by.kind === 'self' ? by.userId : by.actor.userId,
          actorRole: by.kind === 'self' ? null : by.actor.roles.join(',') || null,
          metadata,
        },
        tx,
      );
      return toResponse(await this.repository.get(workerId, tx));
    });
  }
}
