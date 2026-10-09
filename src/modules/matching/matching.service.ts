import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { skipFor } from '../../common/pagination/pagination';
import { toText } from '../availability/domain/time-windows';
import { SearchService } from '../search/search.service';
import type { Actor } from '../users/users.types';
import { CandidateView, MatchCandidatesResponse, MatchRequirementDto } from './dto/matching.dto';

/**
 * Manual matching support (SRS FR-WD-006/007: "search and matching service; admin users match and assign workers manually").
 * Matching answers "which workers fit THIS requirement" by delegating to Search's eligibility, which already enforces
 * active account, submitted profile and full verification - Matching has no code path around them. It does not score,
 * rank, reserve, assign or notify (booking, interview, trial, payment and notification are later modules). Q-46.
 */
@Injectable()
export class MatchingService {
  constructor(
    private readonly search: SearchService,
    private readonly audit: AuditService,
  ) {}

  async candidatesFor(
    requirement: MatchRequirementDto,
    admin: Actor & { userId: string },
    options: { excludeWorkerId?: string } = {},
  ): Promise<MatchCandidatesResponse> {
    const { items, total } = await this.search.findEligible(
      { ...requirement, ...options },
      'SUBMITTED_ASC',
      {
        skip: skipFor(requirement),
        limit: requirement.limit,
      },
    );
    await this.audit.record({
      action: 'matching.candidates',
      entityType: 'matching_request',
      actorId: admin.userId,
      actorRole: admin.roles.join(',') || null,
      // Requirement only: no worker names or contact details in the audit trail.
      metadata: {
        category: requirement.category,
        areaId: requirement.areaId,
        engagement: requirement.engagement,
        availableFrom: requirement.availableFrom,
        availableTo: requirement.availableTo,
        language: requirement.language ?? null,
        minExperienceMonths: requirement.minExperienceMonths ?? null,
        page: requirement.page,
        total,
      },
    });
    return {
      data: items.map((w): CandidateView => ({
        workerId: w.id,
        userId: w.userId,
        name: w.name,
        experienceMonths: w.experienceMonths,
        categories: w.categories,
        languages: w.languages,
        serviceAreas: w.serviceAreas,
        engagementPreference: w.engagementPreference,
        availability: w.availability.map((a) => ({
          start: toText(a.startMinute),
          end: toText(a.endMinute),
        })),
      })),
      meta: { page: requirement.page, limit: requirement.limit, total },
      ordering: 'SUBMITTED_ASC',
      ranked: false,
    };
  }
}
