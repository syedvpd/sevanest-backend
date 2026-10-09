import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { indiaToday } from '../../common/time/india';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import { AppConfigService } from '../../config/app-config.service';
import { ProviderError } from '../../integrations/provider-error';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../integrations/storage/storage-provider.interface';
import type { Actor } from '../users/users.types';
import { WorkersService } from '../workers/workers.service';
import {
  AdminCheckView,
  AdminWorkerVerificationResponse,
  ApproveCheckDto,
  CHECK_TYPES,
  CheckType,
  CheckView,
  DocumentLinkResponse,
  DocumentUploadResponse,
  DocumentView,
  EffectiveCheckStatus,
  QueueItem,
  RequestDocumentUploadDto,
  RequirementsResponse,
  SetRequirementsDto,
  StoredCheckStatus,
  VerificationLevel,
  VerificationQueueQuery,
  WorkerVerificationResponse,
} from './dto/verification.dto';
import {
  CheckRecord,
  DocumentRecord,
  EventRecord,
  VerificationRepository,
} from './verification.repository';

export const VerificationErrorCode = {
  PROFILE_NOT_SUBMITTED: 'PROFILE_NOT_SUBMITTED',
  CHECK_NOT_FOUND: 'CHECK_NOT_FOUND',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  DOCUMENT_TYPE_NOT_ALLOWED: 'DOCUMENT_TYPE_NOT_ALLOWED',
  DOCUMENT_NOT_UPLOADED: 'DOCUMENT_NOT_UPLOADED',
  TOO_MANY_DOCUMENTS: 'TOO_MANY_DOCUMENTS',
  CHECK_NOT_EDITABLE: 'CHECK_NOT_EDITABLE',
  CHECK_INCOMPLETE: 'CHECK_INCOMPLETE',
  CHECK_ALREADY_APPROVED: 'CHECK_ALREADY_APPROVED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
} as const;

/**
 * Technical bound on documents waiting in one check's open draft. The specs give no document count (Q-12), so this is an
 * abuse guard, not a product rule.
 */
const MAX_OPEN_DOCUMENTS_PER_CHECK = 10;

/** Checks whose evidence is an uploaded document. The other two are evidenced by the profile data (FR-VER-009/010). */
const DOCUMENT_CHECKS: ReadonlySet<CheckType> = new Set<CheckType>([
  'IDENTITY',
  'ADDRESS',
  'POLICE_VERIFICATION',
]);

/** A check the worker may still change / (re)submit. */
const EDITABLE: ReadonlySet<EffectiveCheckStatus> = new Set<EffectiveCheckStatus>([
  'NOT_SUBMITTED',
  'REJECTED',
  'RECHECK_DUE',
]);

export type VerificationActor = Actor & { userId: string };

export { indiaToday };

export function effectiveStatus(
  check: Pick<CheckRecord, 'status' | 'recheckAt'> | undefined,
  today: string = indiaToday(),
): EffectiveCheckStatus {
  if (!check) return 'NOT_SUBMITTED';
  if (check.status === 'APPROVED' && check.recheckAt !== null && check.recheckAt <= today) {
    return 'RECHECK_DUE';
  }
  return check.status;
}

/**
 * Worker verification and KYC (FRD FM-05, FR-VER-*, FR-SEC-003/004). Owns the verification tables and the DEFINITION of
 * "fully verified" (verification-eligibility.ts). Documents live in private object storage and are reachable only through
 * short-lived signed links issued after a permission check and audited; the storage key never leaves the backend.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly repository: VerificationRepository,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly outbox: OutboxService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // --- contract for other modules -------------------------------------------------------------------------------

  isFullyVerified(workerId: string): Promise<boolean> {
    return this.repository.isVerified(workerId);
  }

  // --- the worker's own verification ----------------------------------------------------------------------------

  async getMine(userId: string): Promise<WorkerVerificationResponse> {
    const ref = await this.workers.requireRefByUserId(userId);
    return this.workerView(ref.workerId);
  }

  async requestDocumentUpload(
    userId: string,
    checkType: CheckType,
    dto: RequestDocumentUploadDto,
  ): Promise<DocumentUploadResponse> {
    const ref = await this.requireSubmittedWorker(userId);
    const limits = this.config.verificationDocuments;
    if (!limits.contentTypes.includes(dto.contentType)) {
      throw new DomainException(
        VerificationErrorCode.DOCUMENT_TYPE_NOT_ALLOWED,
        'This document type is not accepted',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'contentType', messages: [`accepted types: ${limits.contentTypes.join(', ')}`] }],
      );
    }
    if (dto.sizeBytes > limits.maxBytes) {
      throw new DomainException(
        ErrorCode.PAYLOAD_TOO_LARGE,
        'The document is larger than allowed',
        HttpStatus.PAYLOAD_TOO_LARGE,
        [{ field: 'sizeBytes', messages: [`at most ${limits.maxBytes} bytes`] }],
      );
    }
    // Random, unguessable key that carries no personal data; created before any row so a storage failure writes nothing.
    const objectKey = `kyc/${ref.workerId}/${randomUUID()}`;
    const upload = await this.storageCall(() =>
      this.storage.createUploadUrl({
        objectKey,
        contentType: dto.contentType,
        maxBytes: dto.sizeBytes,
        ttlSeconds: limits.signedUrlTtlSeconds,
      }),
    );
    const documentId = await this.repository.transaction(async (tx) => {
      const draft = await this.repository.ensureCheck(ref.workerId, checkType, tx);
      const check = (await this.repository.lockCheck(draft.id, tx))!;
      if (!EDITABLE.has(effectiveStatus(check))) {
        throw this.notEditable();
      }
      if (
        (await this.repository.countOpenDocuments(check.id, tx)) >= MAX_OPEN_DOCUMENTS_PER_CHECK
      ) {
        throw new DomainException(
          VerificationErrorCode.TOO_MANY_DOCUMENTS,
          'Too many documents are waiting for this check',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const document = await this.repository.createDocument(
        { checkId: check.id, objectKey, contentType: dto.contentType, sizeBytes: dto.sizeBytes },
        tx,
      );
      await this.audit.record(
        {
          action: 'verification.document_request',
          entityType: 'verification_document',
          entityId: document.id,
          actorId: userId,
          metadata: { workerId: ref.workerId, checkType, contentType: dto.contentType },
        },
        tx,
      );
      return document.id;
    });
    return {
      documentId,
      checkType,
      upload: {
        url: upload.url,
        method: 'PUT',
        expiresAt: upload.expiresAt,
        maxBytes: dto.sizeBytes,
        contentType: dto.contentType,
      },
    };
  }

  async confirmDocument(userId: string, documentId: string): Promise<WorkerVerificationResponse> {
    const ref = await this.requireSubmittedWorker(userId);
    const document = await this.repository.findDocument(documentId);
    const check = document ? await this.repository.findCheckById(document.checkId) : null;
    // Another worker's document answers exactly like an unknown one.
    if (!document || !check || check.workerId !== ref.workerId) {
      throw this.documentNotFound();
    }
    if (document.status === 'PENDING_UPLOAD') {
      const info = await this.storageCall(() => this.storage.getObjectInfo(document.objectKey));
      const maxBytes = Math.min(document.sizeBytes, this.config.verificationDocuments.maxBytes);
      if (!info || info.sizeBytes <= 0 || info.sizeBytes > maxBytes) {
        throw new DomainException(
          VerificationErrorCode.DOCUMENT_NOT_UPLOADED,
          'The document has not been uploaded, or its size does not match',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      await this.repository.transaction(async (tx) => {
        const locked = (await this.repository.lockCheck(check.id, tx))!;
        if (!EDITABLE.has(effectiveStatus(locked))) {
          throw this.notEditable();
        }
        const current = (await this.repository.findDocument(document.id, tx))!;
        if (current.status === 'PENDING_UPLOAD') {
          await this.repository.markUploaded(document.id, new Date(), tx);
          await this.audit.record(
            {
              action: 'verification.document_confirm',
              entityType: 'verification_document',
              entityId: document.id,
              actorId: userId,
              metadata: { workerId: ref.workerId, checkType: check.checkType },
            },
            tx,
          );
        }
      });
    }
    return this.workerView(ref.workerId);
  }

  /** "Worker submits an item for review". Repeating the call while it waits for review changes nothing. */
  async submitCheck(userId: string, checkType: CheckType): Promise<WorkerVerificationResponse> {
    const ref = await this.requireSubmittedWorker(userId);
    const evidence = await this.workers.getVerificationEvidence(ref.workerId);
    await this.repository.transaction(async (tx) => {
      const draft = await this.repository.ensureCheck(ref.workerId, checkType, tx);
      const check = (await this.repository.lockCheck(draft.id, tx))!;
      const current = effectiveStatus(check);
      if (current === 'SUBMITTED' || current === 'IN_REVIEW') {
        return;
      }
      if (current === 'APPROVED') {
        throw new DomainException(
          VerificationErrorCode.CHECK_ALREADY_APPROVED,
          'This check is already approved',
          HttpStatus.CONFLICT,
        );
      }
      const missing: string[] = [];
      if (DOCUMENT_CHECKS.has(checkType)) {
        if ((await this.repository.countUploadedOpenDocuments(check.id, tx)) === 0) {
          missing.push('document');
        }
      } else if (checkType === 'EMERGENCY_CONTACT' && !evidence.hasEmergencyContact) {
        missing.push('emergencyContact');
      } else if (checkType === 'PREVIOUS_EMPLOYMENT' && !evidence.hasPreviousEmployer) {
        missing.push('previousEmployer');
      }
      if (missing.length > 0) {
        throw new DomainException(
          VerificationErrorCode.CHECK_INCOMPLETE,
          'The check cannot be submitted yet',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: 'check', messages: missing }],
        );
      }
      const now = new Date();
      await this.repository.stampSubmitted(check.id, now, tx);
      await this.repository.updateCheck(
        check.id,
        {
          status: 'SUBMITTED',
          submittedAt: now,
          reviewedAt: null,
          reviewerUserId: null,
          remarks: null,
          recheckAt: null,
        },
        tx,
      );
      await this.repository.addEvent(
        { checkId: check.id, fromStatus: check.status, toStatus: 'SUBMITTED', actorUserId: userId },
        tx,
      );
      await this.audit.record(
        {
          action: 'verification.check_submit',
          entityType: 'worker_verification_check',
          entityId: check.id,
          actorId: userId,
          metadata: { workerId: ref.workerId, checkType, from: current, to: 'SUBMITTED' },
        },
        tx,
      );
    });
    return this.workerView(ref.workerId);
  }

  // --- review by authorised staff (admin) -----------------------------------------------------------------------

  async adminGetWorker(workerId: string): Promise<AdminWorkerVerificationResponse> {
    await this.workers.requireRefById(workerId);
    return this.adminView(workerId);
  }

  async queue(query: VerificationQueueQuery): Promise<Page<QueueItem>> {
    const statuses: StoredCheckStatus[] = query.status
      ? [query.status]
      : ['SUBMITTED', 'IN_REVIEW'];
    const { items, total, uploadedByCheck } = await this.repository.queue(
      { statuses, checkType: query.checkType },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((c) => ({
        checkId: c.id,
        workerId: c.workerId,
        checkType: c.checkType,
        status: c.status,
        submittedAt: c.submittedAt,
        uploadedDocuments: uploadedByCheck.get(c.id) ?? 0,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  startReview(checkId: string, admin: VerificationActor): Promise<AdminWorkerVerificationResponse> {
    return this.transition(checkId, admin, {
      action: 'verification.start_review',
      from: ['SUBMITTED'],
      to: 'IN_REVIEW',
      idempotentWhen: 'IN_REVIEW',
      update: () => ({ status: 'IN_REVIEW' }),
    });
  }

  approve(
    checkId: string,
    dto: ApproveCheckDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    if (dto.recheckAt !== undefined) {
      const valid = !Number.isNaN(Date.parse(`${dto.recheckAt}T00:00:00Z`));
      if (
        !valid ||
        new Date(`${dto.recheckAt}T00:00:00Z`).toISOString().slice(0, 10) !== dto.recheckAt
      ) {
        throw this.invalidField('recheckAt', 'recheckAt is not a real date');
      }
      if (dto.recheckAt <= indiaToday()) {
        throw this.invalidField('recheckAt', 'recheckAt must be a future date');
      }
    }
    return this.transition(checkId, admin, {
      action: 'verification.approve',
      from: ['IN_REVIEW'],
      to: 'APPROVED',
      remarks: dto.remarks,
      update: (now) => ({
        status: 'APPROVED',
        reviewedAt: now,
        reviewerUserId: admin.userId,
        remarks: dto.remarks ?? null,
        recheckAt: dto.recheckAt ?? null,
      }),
      metadata: { recheckAt: dto.recheckAt ?? null },
    });
  }

  reject(
    checkId: string,
    remarks: string,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.transition(checkId, admin, {
      action: 'verification.reject',
      from: ['IN_REVIEW'],
      to: 'REJECTED',
      remarks,
      update: (now) => ({
        status: 'REJECTED',
        reviewedAt: now,
        reviewerUserId: admin.userId,
        remarks,
      }),
    });
  }

  /** Re-verification on expiry or on demand (FM-05): an approved check goes back to review and stops counting at once. */
  recheck(
    checkId: string,
    remarks: string,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.transition(checkId, admin, {
      action: 'verification.recheck',
      from: ['APPROVED'],
      to: 'IN_REVIEW',
      remarks,
      update: () => ({
        status: 'IN_REVIEW',
        reviewedAt: null,
        reviewerUserId: null,
        remarks: null,
        recheckAt: null,
      }),
    });
  }

  async documentLink(documentId: string, admin: VerificationActor): Promise<DocumentLinkResponse> {
    const document = await this.repository.findDocument(documentId);
    const check = document ? await this.repository.findCheckById(document.checkId) : null;
    if (!document || !check || document.status !== 'UPLOADED') {
      throw this.documentNotFound();
    }
    const link = await this.storageCall(() =>
      this.storage.createDownloadUrl({
        objectKey: document.objectKey,
        ttlSeconds: this.config.verificationDocuments.signedUrlTtlSeconds,
      }),
    );
    // The access is recorded before the link is handed out; if the record fails, no link is returned.
    await this.audit.record({
      action: 'verification.document_view',
      entityType: 'verification_document',
      entityId: document.id,
      actorId: admin.userId,
      actorRole: admin.roles.join(',') || null,
      metadata: { workerId: check.workerId, checkType: check.checkType, checkId: check.id },
    });
    return { url: link.url, expiresAt: link.expiresAt };
  }

  // --- configuration ----------------------------------------------------------------------------------------------

  async getRequirements(): Promise<RequirementsResponse> {
    return { checkTypes: await this.repository.getRequirements() };
  }

  async setRequirements(
    dto: SetRequirementsDto,
    admin: VerificationActor,
  ): Promise<RequirementsResponse> {
    const types = [...dto.checkTypes].sort(
      (a, b) => CHECK_TYPES.indexOf(a) - CHECK_TYPES.indexOf(b),
    );
    await this.repository.transaction(async (tx) => {
      await this.repository.lockRequirements(tx);
      const before = await this.repository.getRequirements(tx);
      if (before.join() === types.join()) {
        return;
      }
      await this.repository.replaceRequirements(types, tx);
      await this.audit.record(
        {
          action: 'verification.requirements_set',
          entityType: 'verification_requirements',
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { before, after: types },
        },
        tx,
      );
    });
    return this.getRequirements();
  }

  // --- internals --------------------------------------------------------------------------------------------------

  private async transition(
    checkId: string,
    admin: VerificationActor,
    rule: {
      action: string;
      from: StoredCheckStatus[];
      to: StoredCheckStatus;
      idempotentWhen?: StoredCheckStatus;
      remarks?: string;
      metadata?: Record<string, unknown>;
      update: (now: Date) => {
        status: StoredCheckStatus;
        reviewedAt?: Date | null;
        reviewerUserId?: string | null;
        remarks?: string | null;
        recheckAt?: string | null;
      };
    },
  ): Promise<AdminWorkerVerificationResponse> {
    const workerId = await this.repository.transaction(async (tx) => {
      const check = await this.repository.lockCheck(checkId, tx);
      if (!check) {
        throw new DomainException(
          VerificationErrorCode.CHECK_NOT_FOUND,
          'Verification check not found',
          HttpStatus.NOT_FOUND,
        );
      }
      if (rule.idempotentWhen && check.status === rule.idempotentWhen) {
        return check.workerId;
      }
      if (!rule.from.includes(check.status)) {
        throw new DomainException(
          VerificationErrorCode.INVALID_TRANSITION,
          `A check that is ${check.status} cannot move to ${rule.to}`,
          HttpStatus.CONFLICT,
        );
      }
      const now = new Date();
      await this.repository.updateCheck(check.id, rule.update(now), tx);
      await this.repository.addEvent(
        {
          checkId: check.id,
          fromStatus: check.status,
          toStatus: rule.to,
          actorUserId: admin.userId,
          remarks: rule.remarks ?? null,
        },
        tx,
      );
      await this.audit.record(
        {
          action: rule.action,
          entityType: 'worker_verification_check',
          entityId: check.id,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          // Remarks are free text written by staff and may name people: they stay in the history table, not in the audit log.
          metadata: {
            workerId: check.workerId,
            checkType: check.checkType,
            from: check.status,
            to: rule.to,
            ...rule.metadata,
          },
        },
        tx,
      );
      if (rule.to === 'APPROVED' || rule.to === 'REJECTED') {
        const worker = await this.workers.requireRefById(check.workerId);
        await this.outbox.notify(
          {
            event:
              rule.to === 'APPROVED'
                ? NotificationEvent.VERIFICATION_APPROVED
                : NotificationEvent.VERIFICATION_REJECTED,
            recipients: [worker.userId],
            params: { checkType: check.checkType },
          },
          tx,
        );
      }
      return check.workerId;
    });
    return this.adminView(workerId);
  }

  private async requireSubmittedWorker(userId: string) {
    const ref = await this.workers.requireRefByUserId(userId);
    if (ref.onboardingStatus !== 'SUBMITTED') {
      throw new DomainException(
        VerificationErrorCode.PROFILE_NOT_SUBMITTED,
        'Submit your profile before starting verification',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return ref;
  }

  private levelOf(required: CheckType[], checks: CheckRecord[], today: string): VerificationLevel {
    const byType = new Map(checks.map((c) => [c.checkType, c]));
    if (
      required.length > 0 &&
      required.every((t) => effectiveStatus(byType.get(t), today) === 'APPROVED')
    ) {
      return 'VERIFIED';
    }
    return checks.some((c) => c.status !== 'NOT_SUBMITTED') ? 'IN_PROGRESS' : 'NOT_STARTED';
  }

  private documentView(document: DocumentRecord): DocumentView {
    return {
      id: document.id,
      status: document.status,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      submitted: document.submittedAt !== null,
      createdAt: document.createdAt,
    };
  }

  private checkViews(
    required: CheckType[],
    checks: CheckRecord[],
    documents: DocumentRecord[],
    today: string,
  ): CheckView[] {
    const byType = new Map(checks.map((c) => [c.checkType, c]));
    return CHECK_TYPES.map((checkType) => {
      const check = byType.get(checkType);
      return {
        checkType,
        status: effectiveStatus(check, today),
        required: required.includes(checkType),
        submittedAt: check?.submittedAt ?? null,
        reviewedAt: check?.reviewedAt ?? null,
        remarks: check?.remarks ?? null,
        recheckAt: check?.recheckAt ?? null,
        documents: check
          ? documents.filter((d) => d.checkId === check.id).map((d) => this.documentView(d))
          : [],
      };
    });
  }

  private async workerView(workerId: string): Promise<WorkerVerificationResponse> {
    const today = indiaToday();
    const [required, checks] = await Promise.all([
      this.repository.getRequirements(),
      this.repository.listChecks(workerId),
    ]);
    const documents = await this.repository.listDocuments(checks.map((c) => c.id));
    return {
      level: this.levelOf(required, checks, today),
      requiredChecks: required,
      checks: this.checkViews(required, checks, documents, today),
    };
  }

  private async adminView(workerId: string): Promise<AdminWorkerVerificationResponse> {
    const today = indiaToday();
    const [required, checks] = await Promise.all([
      this.repository.getRequirements(),
      this.repository.listChecks(workerId),
    ]);
    const [documents, events] = await Promise.all([
      this.repository.listDocuments(checks.map((c) => c.id)),
      this.repository.listEvents(checks.map((c) => c.id)),
    ]);
    const views = this.checkViews(required, checks, documents, today);
    const byType = new Map(checks.map((c) => [c.checkType, c]));
    const eventsByCheck = new Map<string, EventRecord[]>();
    for (const e of events) {
      eventsByCheck.set(e.checkId, [...(eventsByCheck.get(e.checkId) ?? []), e]);
    }
    const adminChecks: AdminCheckView[] = views.map((view) => {
      const check = byType.get(view.checkType);
      return {
        ...view,
        checkId: check?.id ?? '',
        reviewerUserId: check?.reviewerUserId ?? null,
        history: (check ? (eventsByCheck.get(check.id) ?? []) : []).map((e) => ({
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          actorUserId: e.actorUserId,
          remarks: e.remarks,
          createdAt: e.createdAt,
        })),
      };
    });
    return {
      workerId,
      level: this.levelOf(required, checks, today),
      requiredChecks: required,
      checks: adminChecks,
    };
  }

  private async storageCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new DomainException(
          VerificationErrorCode.STORAGE_NOT_CONFIGURED,
          'Document storage is not available',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }

  private notEditable(): DomainException {
    return new DomainException(
      VerificationErrorCode.CHECK_NOT_EDITABLE,
      'This check is waiting for review or already approved, so it cannot be changed now',
      HttpStatus.CONFLICT,
    );
  }

  private documentNotFound(): DomainException {
    return new DomainException(
      VerificationErrorCode.DOCUMENT_NOT_FOUND,
      'Document not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private invalidField(field: string, message: string): DomainException {
    return new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field, messages: [message] }],
    );
  }
}
