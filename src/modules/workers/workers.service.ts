import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, skipFor } from '../../common/pagination/pagination';
import { assertIfMatch } from '../../common/concurrency/if-match';
import { createdRange } from '../../common/time/india';
import { changedFieldNames } from '../../common/validation/fields';
import { maskMobile, normalizeIndianMobile } from '../../common/validation/indian-mobile';
import { assertLanguageSupported } from '../../common/validation/language';
import { AppConfigService } from '../../config/app-config.service';
import type { WorkerOnboardingStatus } from '../../generated/prisma/client';
import { ServiceCategoriesService } from '../service-categories/service-categories.service';
import { UsersService } from '../users/users.service';
import type { Actor, UserRecord } from '../users/users.types';
import {
  AdminCreateWorkerDto,
  AdminWorkerDetail,
  AdminWorkerListQuery,
  AdminWorkerSummary,
  CreateWorkerProfileDto,
  SetCriminalDeclarationDto,
  SetWorkerCategoriesDto,
  SetWorkerReferencesDto,
  UpdateWorkerProfileDto,
  WorkerCategoryRef,
  WorkerProfileResponse,
  WorkerReferenceView,
} from './dto/workers.dto';
import { WorkerBlacklistHooks } from './worker-blacklist.hooks';
import { WorkerSubmissionRegistry } from './worker-submission.registry';
import { ProfileScalarUpdate, WorkerRecord, WorkersRepository } from './workers.repository';

export const WorkersErrorCode = {
  WORKER_PROFILE_EXISTS: 'WORKER_PROFILE_EXISTS',
  WORKER_PROFILE_NOT_FOUND: 'WORKER_PROFILE_NOT_FOUND',
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  MOBILE_IN_USE: 'MOBILE_IN_USE',
  EMERGENCY_CONTACT_NOT_FOUND: 'EMERGENCY_CONTACT_NOT_FOUND',
  PHOTO_REQUIRED: 'PHOTO_REQUIRED',
  REASON_REQUIRED: 'REASON_REQUIRED',
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
    private readonly blacklistHooks: WorkerBlacklistHooks,
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

  /** Contract for Booking: the stored names of these workers, keyed by worker id (one statement). */
  namesByIds(ids: string[]): Promise<Map<string, string>> {
    return this.repository.namesByIds(ids);
  }

  /** Contract for Worker Photo: records which stored object is the current profile photo (never accepted from a request body). */
  setPhotoRef(workerId: string, ref: string, tx: Prisma.TransactionClient): Promise<void> {
    return this.repository.setPhotoRef(workerId, ref, tx);
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
   * The worker's criminal self-declaration with consent. Each call replaces the previous statement and re-stamps the acceptance time on
   * the server. It never blocks submission or verification (no rule is defined for a "yes" answer, Q-117); staff see it on the worker.
   * The audit log records the answer, never the free text.
   */
  async setMyCriminalDeclaration(
    userId: string,
    dto: SetCriminalDeclarationDto,
  ): Promise<WorkerProfileResponse> {
    const ref = await this.requireRefByUserId(userId);
    if (!dto.hasCriminalRecord && dto.details !== undefined) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'details',
            messages: ['details are only accepted when hasCriminalRecord is true'],
          },
        ],
      );
    }
    const updated = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lock(ref.workerId, tx))) {
        throw this.workerNotFound();
      }
      await this.repository.updateScalars(
        ref.workerId,
        {
          criminalRecordDeclared: dto.hasCriminalRecord,
          criminalRecordDetails: dto.hasCriminalRecord ? (dto.details ?? null) : null,
          criminalDeclaredAt: new Date(),
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'worker.criminal_declaration',
          entityType: 'worker_profile',
          entityId: ref.workerId,
          actorId: userId,
          actorRole: null,
          metadata: { hasCriminalRecord: dto.hasCriminalRecord },
        },
        tx,
      );
      return (await this.repository.findById(ref.workerId, tx))!;
    });
    return this.toProfileView(updated, await this.users.findById(updated.userId));
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
      // FM-04 / DEC-10: no verification without a confirmed profile photo.
      if (this.config.profilePhotoRequired && !worker.hasProfilePhoto) {
        throw new DomainException(
          WorkersErrorCode.PHOTO_REQUIRED,
          'Upload and confirm a profile photo before submitting your profile',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: 'profile', messages: ['profilePhoto'] }],
        );
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

  /**
   * Assisted onboarding (FR-WON-007): staff create the account for a mobile and an empty profile. A mobile that already belongs to a
   * customer or staff account, or already has a worker profile, is a 409. The worker signs in later with an OTP sent to that number; the profile is
   * completed through the admin edit endpoints and still goes through the normal submit and verification.
   */
  async adminCreate(
    dto: AdminCreateWorkerDto,
    admin: Actor & { userId: string },
  ): Promise<AdminWorkerDetail> {
    const mobile = normalizeIndianMobile(dto.mobile)!;
    const { user } = await this.users.findOrCreateByMobile(mobile, 'WORKER');
    if (user.type !== 'WORKER') {
      throw new DomainException(
        WorkersErrorCode.MOBILE_IN_USE,
        'This mobile number belongs to another kind of account',
        HttpStatus.CONFLICT,
      );
    }
    try {
      const worker = await this.repository.transaction(async (tx) => {
        const created = await this.repository.create({ userId: user.id, name: dto.name }, tx);
        await this.audit.record(
          {
            action: 'worker.admin_create',
            entityType: 'worker_profile',
            entityId: created.id,
            actorId: admin.userId,
            actorRole: admin.roles?.join(',') || null,
            metadata: { onboardingStatus: created.onboardingStatus },
          },
          tx,
        );
        return created;
      });
      return this.adminGet(worker.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          WorkersErrorCode.WORKER_PROFILE_EXISTS,
          'A worker profile already exists for this mobile number',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  // --- references (PRD 6.1) ---------------------------------------------------------------------------------

  async getMyReferences(userId: string): Promise<WorkerReferenceView[]> {
    const ref = await this.requireRefByUserId(userId);
    return this.repository.listReferences(ref.workerId);
  }

  /** Replaces the worker's reference list. Each mobile once; the worker's own number is refused. Audited with counts only (no personal data). */
  async setMyReferences(
    userId: string,
    dto: SetWorkerReferencesDto,
  ): Promise<WorkerReferenceView[]> {
    const ref = await this.requireRefByUserId(userId);
    const own = (await this.users.findById(userId))?.mobile ?? null;
    const seen = new Set<string>();
    for (const r of dto.references) {
      if (seen.has(r.mobile) || r.mobile === own) {
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          'Request validation failed',
          HttpStatus.BAD_REQUEST,
          [
            {
              field: 'references',
              messages: ['each reference needs a different mobile that is not your own'],
            },
          ],
        );
      }
      seen.add(r.mobile);
    }
    await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lock(ref.workerId, tx))) throw this.workerNotFound();
      await this.repository.replaceReferences(ref.workerId, dto.references, tx);
      await this.audit.record(
        {
          action: 'worker.references_set',
          entityType: 'worker_profile',
          entityId: ref.workerId,
          actorId: userId,
          metadata: { count: dto.references.length },
        },
        tx,
      );
    });
    return this.repository.listReferences(ref.workerId);
  }

  /** Staff read of a worker's references: personal data of third parties, so every read is audited. */
  async adminReferences(
    workerId: string,
    actor: Actor & { userId: string },
  ): Promise<WorkerReferenceView[]> {
    await this.requireRefById(workerId);
    const list = await this.repository.listReferences(workerId);
    await this.audit.record({
      action: 'worker.sensitive_view',
      entityType: 'worker_profile',
      entityId: workerId,
      actorId: actor.userId,
      actorRole: actor.roles?.join(',') || null,
      metadata: { groups: ['references'] },
    });
    return list;
  }

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
      {
        onboardingStatus: query.onboardingStatus,
        categoryId: query.categoryId,
        userId,
        name: query.name,
        accountStatus: query.accountStatus,
        areaId: query.areaId,
        minRating: query.minRating,
        verified: query.verified,
        ...createdRange(query.createdFrom, query.createdTo),
      },
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

  /**
   * The full profile as staff read it, including the home address and the emergency contact. Every such read is audited (who, which worker,
   * which sensitive groups) so access to the emergency contact is traceable; the viewing policy itself is still undecided (Q-78 interim:
   * any admin with worker.view, audited).
   */
  async adminRead(workerId: string, actor: Actor & { userId: string }): Promise<AdminWorkerDetail> {
    const detail = await this.adminGet(workerId);
    await this.audit.record({
      action: 'worker.sensitive_view',
      entityType: 'worker_profile',
      entityId: workerId,
      actorId: actor.userId,
      actorRole: actor.roles?.join(',') || null,
      metadata: { groups: ['address', 'criminalDeclaration'] },
    });
    return detail;
  }

  async adminGet(workerId: string): Promise<AdminWorkerDetail> {
    const worker = await this.repository.findById(workerId);
    if (!worker) {
      throw this.workerNotFound();
    }
    const user = await this.users.findById(worker.userId);
    return {
      ...(await this.toProfileView(worker, user)),
      // DEC-09: the emergency contact is never part of the staff profile; it is revealed on request with a reason (audited).
      emergencyContact: null,
      hasEmergencyContact: worker.emergencyContact !== null,
      blacklist: worker.blacklist,
      userId: worker.userId,
      accountStatus: user?.status ?? 'ACTIVE',
    };
  }

  /**
   * DEC-09: the one way staff read a worker's emergency contact. A reason is mandatory and the reveal is audited with it (who, which
   * worker, why). The contact is never returned to customers and the general staff profile redacts it.
   */
  async revealEmergencyContact(
    workerId: string,
    reason: string | undefined,
    actor: Actor & { userId: string },
  ): Promise<{ name: string; mobile: string }> {
    if (!reason || reason.length < 5) {
      throw new DomainException(
        WorkersErrorCode.REASON_REQUIRED,
        'A reason of at least 5 characters is required to reveal an emergency contact',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'reason', messages: ['reason is required'] }],
      );
    }
    const worker = await this.repository.findById(workerId);
    if (!worker) throw this.workerNotFound();
    if (!worker.emergencyContact) {
      throw new DomainException(
        WorkersErrorCode.EMERGENCY_CONTACT_NOT_FOUND,
        'This worker has no emergency contact on file',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.audit.record({
      action: 'worker.emergency_contact_reveal',
      entityType: 'worker_profile',
      entityId: workerId,
      actorId: actor.userId,
      actorRole: actor.roles?.join(',') || null,
      metadata: { reason },
    });
    return worker.emergencyContact;
  }

  /**
   * DEC-06: blacklist a worker. They leave search, matching and every eligibility check at once (profile flag), their account is suspended
   * (so every session ends and they cannot sign in), and staff are alerted to each open booking they hold. Audited with the reason.
   * Repeating is safe: the flag stays, the account stays suspended, open bookings are flagged again (deduplicated alerts).
   */
  async blacklist(
    workerId: string,
    reason: string,
    actor: Actor & { userId: string },
  ): Promise<AdminWorkerDetail> {
    const worker = await this.repository.findById(workerId);
    if (!worker) throw this.workerNotFound();
    if (!worker.blacklist) {
      await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lock(workerId, tx))) throw this.workerNotFound();
        await this.repository.setBlacklist(workerId, { reason, byUserId: actor.userId }, tx);
        await this.audit.record(
          {
            action: 'worker.blacklist',
            entityType: 'worker_profile',
            entityId: workerId,
            actorId: actor.userId,
            actorRole: actor.roles?.join(',') || null,
            metadata: { reason },
          },
          tx,
        );
      });
    }
    // Suspension ends every session and stops sign-in (changeStatus is a no-op when already suspended).
    await this.users.changeStatus(worker.userId, 'SUSPENDED', `Blacklisted: ${reason}`, actor, []);
    await this.blacklistHooks.blacklisted({
      workerId,
      userId: worker.userId,
      reason,
      actorUserId: actor.userId,
    });
    return this.adminGet(workerId);
  }

  /** Lifting is a Super Admin decision (route permission) and reactivates the account. Audited. */
  async liftBlacklist(
    workerId: string,
    reason: string,
    actor: Actor & { userId: string },
  ): Promise<AdminWorkerDetail> {
    const worker = await this.repository.findById(workerId);
    if (!worker) throw this.workerNotFound();
    if (worker.blacklist) {
      await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lock(workerId, tx))) throw this.workerNotFound();
        await this.repository.setBlacklist(workerId, null, tx);
        await this.audit.record(
          {
            action: 'worker.blacklist_lift',
            entityType: 'worker_profile',
            entityId: workerId,
            actorId: actor.userId,
            actorRole: actor.roles?.join(',') || null,
            metadata: { reason, previousReason: worker.blacklist?.reason },
          },
          tx,
        );
      });
      await this.users.changeStatus(
        worker.userId,
        'ACTIVE',
        `Blacklist lifted: ${reason}`,
        actor,
        [],
      );
    }
    return this.adminGet(workerId);
  }

  async adminUpdate(
    workerId: string,
    dto: UpdateWorkerProfileDto,
    actor: Actor & { userId: string },
    ifMatch?: string,
  ): Promise<AdminWorkerDetail> {
    await this.requireRefById(workerId);
    await this.update(workerId, dto, { kind: 'admin', actor }, ifMatch);
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
    ifMatch?: string,
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
      if (ifMatch !== undefined) {
        assertIfMatch(ifMatch, (await this.repository.findById(workerId, tx))!.updatedAt);
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
    if (this.config.profilePhotoRequired && !worker.hasProfilePhoto) own.push('profilePhoto');
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
      preferredLanguage: worker.preferredLanguage,
      languages: worker.languages,
      address: worker.address,
      emergencyContact: worker.emergencyContact,
      previousEmployer: worker.previousEmployer,
      hasProfilePhoto: worker.hasProfilePhoto,
      criminalDeclaration: worker.criminalDeclaration,
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
  if (dto.preferredLanguage !== undefined) data.preferredLanguage = dto.preferredLanguage;
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
