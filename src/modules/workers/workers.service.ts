import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, skipFor } from '../../common/pagination/pagination';
import { changedFieldNames } from '../../common/validation/fields';
import { maskMobile, normalizeIndianMobile } from '../../common/validation/indian-mobile';
import { assertLanguageSupported } from '../../common/validation/language';
import { AppConfigService } from '../../config/app-config.service';
import type { WorkerOnboardingStatus } from '../../generated/prisma/client';
import { ServiceCategoriesService } from '../service-categories/service-categories.service';
import { UsersService } from '../users/users.service';
import type { Actor, UserRecord } from '../users/users.types';
import {
  AdminWorkerDetail,
  AdminWorkerListQuery,
  AdminWorkerSummary,
  CreateWorkerProfileDto,
  SetWorkerCategoriesDto,
  UpdateWorkerProfileDto,
  WorkerCategoryRef,
  WorkerProfileResponse,
} from './dto/workers.dto';
import { WorkerSubmissionRegistry } from './worker-submission.registry';
import { ProfileScalarUpdate, WorkerRecord, WorkersRepository } from './workers.repository';

export const WorkersErrorCode = {
  WORKER_PROFILE_EXISTS: 'WORKER_PROFILE_EXISTS',
  WORKER_PROFILE_NOT_FOUND: 'WORKER_PROFILE_NOT_FOUND',
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
} as const;

/** Who is acting on a worker profile: the worker themself, or an admin (assisted onboarding). */
export type WorkerActor =
  { kind: 'self'; userId: string } | { kind: 'admin'; actor: Actor & { userId: string } };

/** The small, private-data-free view other modules (Search, Matching, Booking) may consume. */
export interface WorkerContract {
  id: string;
  userId: string;
  name: string;
  onboardingStatus: WorkerOnboardingStatus;
  experienceMonths: number | null;
  languages: string[];
  categoryIds: string[];
}

export interface WorkerRef {
  workerId: string;
  userId: string;
  onboardingStatus: WorkerOnboardingStatus;
}

/**
 * Worker profile / work profile (FRD FM-04, SRS 3.8-3.9) built on the existing account. Owns profile data, languages
 * and role (category) associations. Preferred areas, time windows and engagement preference belong to Availability.
 * KYC and documents belong to the future Verification module and never pass through here.
 */
@Injectable()
export class WorkersService {
  constructor(
    private readonly repository: WorkersRepository,
    private readonly categories: ServiceCategoriesService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly registry: WorkerSubmissionRegistry,
  ) {}

  // --- contract for other modules ---------------------------------------------------------------------------

  async findRefByUserId(userId: string): Promise<WorkerRef | null> {
    const worker = await this.repository.findByUserId(userId);
    return worker
      ? { workerId: worker.id, userId: worker.userId, onboardingStatus: worker.onboardingStatus }
      : null;
  }

  async requireRefByUserId(userId: string): Promise<WorkerRef> {
    const ref = await this.findRefByUserId(userId);
    if (!ref) {
      throw this.profileNotFound();
    }
    return ref;
  }

  async requireRefById(workerId: string): Promise<WorkerRef> {
    const worker = await this.repository.findById(workerId);
    if (!worker) {
      throw this.workerNotFound();
    }
    return {
      workerId: worker.id,
      userId: worker.userId,
      onboardingStatus: worker.onboardingStatus,
    };
  }

  /** What Verification needs to know about the profile data it reviews, without handing out the private values. */
  async getVerificationEvidence(
    workerId: string,
  ): Promise<{ hasEmergencyContact: boolean; hasPreviousEmployer: boolean }> {
    const worker = await this.repository.findById(workerId);
    if (!worker) {
      throw this.workerNotFound();
    }
    return {
      hasEmergencyContact: worker.emergencyContact !== null,
      hasPreviousEmployer: worker.previousEmployer !== null,
    };
  }

  async getContract(workerId: string): Promise<WorkerContract> {
    const worker = await this.repository.findById(workerId);
    if (!worker) {
      throw this.workerNotFound();
    }
    return {
      id: worker.id,
      userId: worker.userId,
      name: worker.name,
      onboardingStatus: worker.onboardingStatus,
      experienceMonths: worker.experienceMonths,
      languages: worker.languages,
      categoryIds: worker.categoryIds,
    };
  }

  // --- the worker's own profile -----------------------------------------------------------------------------

  async createMyProfile(
    userId: string,
    dto: CreateWorkerProfileDto,
  ): Promise<WorkerProfileResponse> {
    try {
      const created = await this.repository.transaction(async (tx) => {
        const worker = await this.repository.create({ userId, name: dto.name }, tx);
        await this.audit.record(
          {
            action: 'worker.profile_create',
            entityType: 'worker_profile',
            entityId: worker.id,
            actorId: userId,
            metadata: { onboardingStatus: worker.onboardingStatus },
          },
          tx,
        );
        return worker;
      });
      return this.toProfileView(created, await this.users.findById(userId));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          WorkersErrorCode.WORKER_PROFILE_EXISTS,
          'A profile already exists for this account',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async getMyProfile(userId: string): Promise<WorkerProfileResponse> {
    const worker = await this.repository.findByUserId(userId);
    if (!worker) {
      throw this.profileNotFound();
    }
    return this.toProfileView(worker, await this.users.findById(userId));
  }

  async updateMyProfile(
    userId: string,
    dto: UpdateWorkerProfileDto,
  ): Promise<WorkerProfileResponse> {
    const ref = await this.requireRefByUserId(userId);
    return this.update(ref.workerId, dto, { kind: 'self', userId });
  }

  async setMyCategories(
    userId: string,
    dto: SetWorkerCategoriesDto,
  ): Promise<WorkerProfileResponse> {
    const ref = await this.requireRefByUserId(userId);
    return this.setCategories(ref.workerId, dto, { kind: 'self', userId });
  }

  /**
   * "Worker submits profile for verification" (FM-04 step 7). Requires the fields FM-04 marks mandatory that this system
   * can hold today. The profile photo and KYC documents are NOT checked here: photo upload has no storage integration yet
   * and KYC belongs to the Verification module. Repeating the call on a submitted profile is a no-op.
   */
  async submitMyProfile(userId: string): Promise<WorkerProfileResponse> {
    const ref = await this.requireRefByUserId(userId);
    const submitted = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lock(ref.workerId, tx))) {
        throw this.profileNotFound();
      }
      const worker = (await this.repository.findById(ref.workerId, tx))!;
      if (worker.onboardingStatus === 'SUBMITTED') {
        return worker;
      }
      const missing = await this.missingForSubmission(worker);
      if (missing.length > 0) {
        throw new DomainException(
          WorkersErrorCode.PROFILE_INCOMPLETE,
          'The profile is not complete',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: 'profile', messages: missing }],
        );
      }
      await this.repository.markSubmitted(worker.id, new Date(), tx);
      await this.audit.record(
        {
          action: 'worker.profile_submit',
          entityType: 'worker_profile',
          entityId: worker.id,
          actorId: userId,
          metadata: { from: 'DRAFT', to: 'SUBMITTED' },
        },
        tx,
      );
      return (await this.repository.findById(worker.id, tx))!;
    });
    return this.toProfileView(submitted, await this.users.findById(userId));
  }

  // --- admin (permissions worker.view / worker.manage) ------------------------------------------------------

  async adminList(query: AdminWorkerListQuery): Promise<Page<AdminWorkerSummary>> {
    let userId: string | undefined;
    if (query.mobile !== undefined) {
      const normalized = normalizeIndianMobile(query.mobile);
      const user = normalized ? await this.users.findByMobile(normalized) : null;
      if (!user) {
        return { data: [], meta: { page: query.page, limit: query.limit, total: 0 } };
      }
      userId = user.id;
    }
    const { items, total } = await this.repository.list(
      { onboardingStatus: query.onboardingStatus, categoryId: query.categoryId, userId },
      skipFor(query),
      query.limit,
    );
    const [users, categories] = await Promise.all([
      this.users.findManyByIds(items.map((w) => w.userId)),
      this.categoryRefs(items.flatMap((w) => w.categoryIds)),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    return {
      data: items.map((worker) => ({
        id: worker.id,
        userId: worker.userId,
        name: worker.name,
        mobile: maskMobile(userById.get(worker.userId)?.mobile),
        onboardingStatus: worker.onboardingStatus,
        accountStatus: userById.get(worker.userId)?.status ?? 'ACTIVE',
        categories: worker.categoryIds
          .map((id) => categories.get(id))
          .filter((c): c is WorkerCategoryRef => c !== undefined),
        createdAt: worker.createdAt,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(workerId: string): Promise<AdminWorkerDetail> {
    const worker = await this.repository.findById(workerId);
    if (!worker) {
      throw this.workerNotFound();
    }
    const user = await this.users.findById(worker.userId);
    return {
      ...(await this.toProfileView(worker, user)),
      userId: worker.userId,
      accountStatus: user?.status ?? 'ACTIVE',
    };
  }

  async adminUpdate(
    workerId: string,
    dto: UpdateWorkerProfileDto,
    actor: Actor & { userId: string },
  ): Promise<AdminWorkerDetail> {
    await this.requireRefById(workerId);
    await this.update(workerId, dto, { kind: 'admin', actor });
    return this.adminGet(workerId);
  }

  async adminSetCategories(
    workerId: string,
    dto: SetWorkerCategoriesDto,
    actor: Actor & { userId: string },
  ): Promise<AdminWorkerDetail> {
    await this.requireRefById(workerId);
    await this.setCategories(workerId, dto, { kind: 'admin', actor });
    return this.adminGet(workerId);
  }

  // --- shared mutations -------------------------------------------------------------------------------------

  private async update(
    workerId: string,
    dto: UpdateWorkerProfileDto,
    by: WorkerActor,
  ): Promise<WorkerProfileResponse> {
    const fields = changedFieldNames(dto);
    if (fields.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'body', messages: ['at least one field must be provided'] }],
      );
    }
    if (dto.languages) {
      for (const language of dto.languages) {
        assertLanguageSupported(language, this.config.supportedLanguages, 'languages');
      }
    }
    const updated = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lock(workerId, tx))) {
        throw this.workerNotFound();
      }
      await this.repository.updateScalars(workerId, scalarUpdate(dto), tx);
      if (dto.languages) {
        await this.repository.replaceLanguages(workerId, dto.languages, tx);
      }
      await this.audit.record(
        {
          action: 'worker.profile_update',
          entityType: 'worker_profile',
          entityId: workerId,
          ...auditActor(by),
          // Field NAMES only: values are personal data.
          metadata: { changedFields: fields },
        },
        tx,
      );
      return (await this.repository.findById(workerId, tx))!;
    });
    return this.toProfileView(updated, await this.users.findById(updated.userId));
  }

  private async setCategories(
    workerId: string,
    dto: SetWorkerCategoriesDto,
    by: WorkerActor,
  ): Promise<WorkerProfileResponse> {
    const updated = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lock(workerId, tx))) {
        throw this.workerNotFound();
      }
      const current = (await this.repository.findById(workerId, tx))!;
      await this.categories.assertAssignable(dto.categoryIds, current.categoryIds);
      const requested = new Set(dto.categoryIds);
      const held = new Set(current.categoryIds);
      const added = dto.categoryIds.filter((id) => !held.has(id));
      const removed = current.categoryIds.filter((id) => !requested.has(id));
      await this.repository.removeSkills(workerId, removed, tx);
      await this.repository.addSkills(workerId, added, tx);
      if (added.length > 0 || removed.length > 0) {
        await this.audit.record(
          {
            action: 'worker.categories_set',
            entityType: 'worker_profile',
            entityId: workerId,
            ...auditActor(by),
            metadata: { added, removed },
          },
          tx,
        );
      }
      return (await this.repository.findById(workerId, tx))!;
    });
    return this.toProfileView(updated, await this.users.findById(updated.userId));
  }

  // --- views ------------------------------------------------------------------------------------------------

  /** What is missing before submission: this module's own mandatory fields plus those other modules contribute. */
  private async missingForSubmission(worker: WorkerRecord): Promise<string[]> {
    const own: string[] = [];
    if (!worker.address) own.push('address');
    if (!worker.emergencyContact) own.push('emergencyContact');
    if (worker.categoryIds.length === 0) own.push('categories');
    if (worker.languages.length === 0) own.push('languages');
    if (worker.experienceMonths === null) own.push('experience');
    return [...own, ...(await this.registry.missingFor(worker.id))];
  }

  private async categoryRefs(ids: string[]): Promise<Map<string, WorkerCategoryRef>> {
    const found = await this.categories.findByIds([...new Set(ids)]);
    return new Map(
      found.map((c) => [c.id, { id: c.id, code: c.code, name: c.name, isEnabled: c.isEnabled }]),
    );
  }

  private async toProfileView(
    worker: WorkerRecord,
    user: UserRecord | null,
  ): Promise<WorkerProfileResponse> {
    const [categories, missing] = await Promise.all([
      this.categoryRefs(worker.categoryIds),
      worker.onboardingStatus === 'DRAFT' ? this.missingForSubmission(worker) : Promise.resolve([]),
    ]);
    return {
      id: worker.id,
      name: worker.name,
      mobile: user?.mobile ?? '',
      onboardingStatus: worker.onboardingStatus,
      submittedAt: worker.submittedAt,
      experienceMonths: worker.experienceMonths,
      expectedSalary: worker.expectedSalary,
      languages: worker.languages,
      address: worker.address,
      emergencyContact: worker.emergencyContact,
      previousEmployer: worker.previousEmployer,
      hasProfilePhoto: worker.hasProfilePhoto,
      categories: worker.categoryIds
        .map((id) => categories.get(id))
        .filter((c): c is WorkerCategoryRef => c !== undefined),
      missingForSubmission: missing,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
    };
  }

  private profileNotFound(): DomainException {
    return new DomainException(
      WorkersErrorCode.WORKER_PROFILE_NOT_FOUND,
      'Worker profile not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private workerNotFound(): DomainException {
    return new DomainException(
      WorkersErrorCode.WORKER_NOT_FOUND,
      'Worker not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

function auditActor(by: WorkerActor): { actorId: string; actorRole: string | null } {
  return by.kind === 'self'
    ? { actorId: by.userId, actorRole: null }
    : { actorId: by.actor.userId, actorRole: by.actor.roles.join(',') || null };
}

/** Maps the DTO to columns: undefined = untouched; groups are replaced whole; null clears optional values. */
function scalarUpdate(dto: UpdateWorkerProfileDto): ProfileScalarUpdate {
  const data: ProfileScalarUpdate = {};
  if (dto.name !== undefined) data.name = dto.name;
  if (dto.experienceMonths !== undefined) data.experienceMonths = dto.experienceMonths;
  if (dto.expectedSalary !== undefined) data.expectedSalary = dto.expectedSalary;
  if (dto.address) {
    data.addressLine = dto.address.line;
    data.addressArea = dto.address.area;
    data.addressCity = dto.address.city;
    data.addressPincode = dto.address.pincode;
  }
  if (dto.emergencyContact) {
    data.emergencyContactName = dto.emergencyContact.name;
    data.emergencyContactMobile = dto.emergencyContact.mobile;
  }
  if (dto.previousEmployer !== undefined) {
    data.previousEmployerName = dto.previousEmployer?.name ?? null;
    data.previousEmployerMobile = dto.previousEmployer?.mobile ?? null;
  }
  return data;
}
