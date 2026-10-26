import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { AlertsService } from '../alerts/alerts.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { indiaToday } from '../../common/time/india';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import { AppConfigService } from '../../config/app-config.service';
import { ProviderError } from '../../integrations/provider-error';
import { MALWARE_SCANNER, type MalwareScanner } from '../../integrations/malware/malware-scanner';
import { validateContent } from '../../integrations/storage/file-signature';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../integrations/storage/storage-provider.interface';
import type { Actor } from '../users/users.types';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import {
  AddNoteDto,
  AdminCheckView,
  AdminDocumentView,
  ApplicationStatus,
  DocumentDetailsDto,
  ReassignReviewDto,
  RejectCheckDto,
  ReleaseReviewDto,
  SignOffDto,
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
  CLAIM_INACTIVITY_MINUTES,
  maskDocumentNumber,
  REJECTION_MESSAGES,
  slaOf,
  TERMINAL_REJECTION_CODES,
} from './verification-policy';
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
  DOCUMENT_NOT_AVAILABLE: 'DOCUMENT_NOT_AVAILABLE',
  DOCUMENT_OBJECT_MISSING: 'DOCUMENT_OBJECT_MISSING',
  DOCUMENT_TYPE_NOT_ALLOWED: 'DOCUMENT_TYPE_NOT_ALLOWED',
  DOCUMENT_NOT_UPLOADED: 'DOCUMENT_NOT_UPLOADED',
  DOCUMENT_CONTENT_MISMATCH: 'DOCUMENT_CONTENT_MISMATCH',
  DOCUMENT_MALWARE_DETECTED: 'DOCUMENT_MALWARE_DETECTED',
  DOCUMENT_INTEGRITY_FAILED: 'DOCUMENT_INTEGRITY_FAILED',
  TOO_MANY_DOCUMENTS: 'TOO_MANY_DOCUMENTS',
  CHECK_NOT_EDITABLE: 'CHECK_NOT_EDITABLE',
  CHECK_INCOMPLETE: 'CHECK_INCOMPLETE',
  CHECK_ALREADY_APPROVED: 'CHECK_ALREADY_APPROVED',
  CHECK_ALREADY_ASSIGNED: 'CHECK_ALREADY_ASSIGNED',
  CHECK_NOT_ASSIGNED_TO_YOU: 'CHECK_NOT_ASSIGNED_TO_YOU',
  CHECK_NOT_CLAIMED: 'CHECK_NOT_CLAIMED',
  CHECK_DISQUALIFIED: 'CHECK_DISQUALIFIED',
  APPROVAL_REQUIREMENTS_MISSING: 'APPROVAL_REQUIREMENTS_MISSING',
  REVIEWER_NOT_ELIGIBLE: 'REVIEWER_NOT_ELIGIBLE',
  NOT_FULLY_VERIFIED: 'NOT_FULLY_VERIFIED',
  WORKER_DISQUALIFIED: 'WORKER_DISQUALIFIED',
  NOT_SIGNED_OFF: 'NOT_SIGNED_OFF',
  ACTIVATION_REQUIREMENTS_MISSING: 'ACTIVATION_REQUIREMENTS_MISSING',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
} as const;

/**
 * Technical bound on documents waiting in one check's open draft. The specs give no document count (Q-12), so this is an
 * abuse guard, not a product rule.
 */
const MAX_OPEN_DOCUMENTS_PER_CHECK = 10;

/** Checks whose evidence is an uploaded document. Emergency contact and previous employment are evidenced by the profile data (FR-VER-009/010). */
const DOCUMENT_CHECKS: ReadonlySet<CheckType> = new Set<CheckType>([
  'IDENTITY',
  'ADDRESS',
  'POLICE_VERIFICATION',
  'SKILL_CERTIFICATE',
  'LICENSE',
]);

/** A check the worker may still change / (re)submit. */
const EDITABLE: ReadonlySet<EffectiveCheckStatus> = new Set<EffectiveCheckStatus>([
  'NOT_SUBMITTED',
  'REJECTED',
  'RECHECK_DUE',
]);

export type VerificationActor = Actor & { userId: string; permissions: string[] };

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
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly repository: VerificationRepository,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly outbox: OutboxService,
    private readonly alerts: AlertsService,
    private readonly users: UsersService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  // --- contract for other modules -------------------------------------------------------------------------------

  isFullyVerified(workerId: string): Promise<boolean> {
    return this.repository.isVerified(workerId);
  }

  /**
   * Scheduler entry (worker process): reminds each worker once per due date that an approved check is due for re-check
   * (FRD section 6 "Recheck due"). Purely a notification: it never changes a check, so it can neither mark a worker verified
   * nor touch searchability, which already excludes a check once its date is reached (verifiedWorkerCondition). The admin
   * recipient of the FRD matrix has no defined routing (Q-57) and is not notified. Idempotent: safe to run concurrently.
   */
  async notifyRecheckDue(limit = 100): Promise<number> {
    return this.repository.transaction(async (tx) => {
      const due = await this.repository.claimRecheckDue(limit, tx);
      for (const row of due) {
        await this.outbox.notify(
          {
            event: NotificationEvent.RECHECK_DUE,
            recipients: [row.userId],
            params: { checkType: row.checkType },
          },
          tx,
        );
      }
      await this.repository.markRecheckNotified(
        due.map((d) => d.checkId),
        tx,
      );
      return due.length;
    });
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
      this.assertNotDisqualified(check);
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
      if (document.purgedAt) {
        // The upload was rejected and discarded earlier: a fresh upload slot must be requested.
        throw this.notUploaded();
      }
      const info = await this.storageCall(() => this.storage.getObjectInfo(document.objectKey));
      if (!info) throw this.notUploaded();
      const maxBytes = Math.min(document.sizeBytes, this.config.verificationDocuments.maxBytes);
      // The signed PUT cannot cap the size, so the cap is enforced here: an oversized, empty or differently-sized object is
      // discarded instead of being left in the bucket.
      if (
        info.sizeBytes <= 0 ||
        info.sizeBytes > maxBytes ||
        info.sizeBytes !== document.sizeBytes
      ) {
        await this.rejectUpload(document, check, ref.workerId, userId, 'SIZE_MISMATCH');
        throw this.notUploaded();
      }
      const object = await this.storageCall(() =>
        this.storage.readObject(document.objectKey, maxBytes),
      );
      if (!object) throw this.notUploaded();
      if (object.truncated || object.bytes.length !== info.sizeBytes) {
        await this.rejectUpload(document, check, ref.workerId, userId, 'SIZE_MISMATCH');
        throw this.notUploaded();
      }
      // The client-declared type is never trusted: the real bytes must be a complete file of that type.
      const verdict = validateContent(document.contentType, object.bytes);
      if (!verdict.ok) {
        await this.rejectUpload(document, check, ref.workerId, userId, `CONTENT_${verdict.reason}`);
        throw new DomainException(
          VerificationErrorCode.DOCUMENT_CONTENT_MISMATCH,
          'The uploaded file is not of the declared type',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (this.scanner.enabled) {
        // A scanner that cannot answer leaves the document unconfirmed (never accepted unscanned) and the object in place for a retry.
        const scan = await this.scanner.scan(object.bytes).catch((error: unknown) => {
          this.logger.error(`Malware scan unavailable: ${(error as Error).message}`);
          throw new DomainException(
            ErrorCode.SERVICE_UNAVAILABLE,
            'The document could not be checked right now: try confirming again shortly',
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        });
        if (!scan.clean) {
          await this.rejectUpload(document, check, ref.workerId, userId, 'MALWARE_DETECTED');
          throw new DomainException(
            VerificationErrorCode.DOCUMENT_MALWARE_DETECTED,
            'The uploaded file was rejected by the security check',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
      }
      const contentSha256 = createHash('sha256').update(object.bytes).digest('hex');
      await this.repository.transaction(async (tx) => {
        const locked = (await this.repository.lockCheck(check.id, tx))!;
        if (!EDITABLE.has(effectiveStatus(locked))) {
          throw this.notEditable();
        }
        const current = (await this.repository.findDocument(document.id, tx))!;
        if (current.status === 'PENDING_UPLOAD') {
          await this.repository.markUploaded(
            document.id,
            new Date(),
            { contentSha256, storageEtag: info.etag ?? null },
            tx,
          );
          await this.audit.record(
            {
              action: 'verification.document_confirm',
              entityType: 'verification_document',
              entityId: document.id,
              actorId: userId,
              metadata: { workerId: ref.workerId, checkType: check.checkType, contentSha256 },
            },
            tx,
          );
        }
      });
    }
    return this.workerView(ref.workerId);
  }

  /** "Worker submits an item for review". Repeating the call while it waits for review changes nothing. */
  async submitCheck(
    userId: string,
    checkType: CheckType,
    details: DocumentDetailsDto = {},
  ): Promise<WorkerVerificationResponse> {
    const ref = await this.requireSubmittedWorker(userId);
    const evidence = await this.workers.getVerificationEvidence(ref.workerId);
    await this.repository.transaction(async (tx) => {
      const draft = await this.repository.ensureCheck(ref.workerId, checkType, tx);
      const check = (await this.repository.lockCheck(draft.id, tx))!;
      const current = effectiveStatus(check);
      if (current === 'SUBMITTED' || current === 'IN_REVIEW') {
        return;
      }
      this.assertNotDisqualified(check);
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
      const maskedNumber = details.documentNumber
        ? this.maskedOrFail(details.documentNumber)
        : undefined;
      const expiresOn = details.expiresOn
        ? this.futureDateOrFail('expiresOn', details.expiresOn)
        : undefined;
      const now = new Date();
      await this.repository.stampSubmitted(check.id, now, tx);
      await this.repository.updateCheck(
        check.id,
        {
          status: 'SUBMITTED',
          submittedAt: now,
          reviewedAt: null,
          reviewerUserId: null,
          claimedAt: null,
          lastActivityAt: null,
          rejectionCode: null,
          remarks: null,
          recheckAt: null,
          ...(maskedNumber !== undefined ? { maskedDocumentNumber: maskedNumber } : {}),
          ...(expiresOn !== undefined ? { documentExpiresOn: expiresOn } : {}),
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

  async queue(query: VerificationQueueQuery, admin: VerificationActor): Promise<Page<QueueItem>> {
    if (query.assignedTo && query.reviewerId) {
      throw this.invalidField('reviewerId', 'Use either assignedTo or reviewerId, not both');
    }
    const statuses: StoredCheckStatus[] = query.status
      ? [query.status]
      : ['SUBMITTED', 'IN_REVIEW'];
    const { items, total, uploadedByCheck } = await this.repository.queue(
      {
        statuses,
        checkType: query.checkType,
        reviewerUserId: query.assignedTo === 'me' ? admin.userId : query.reviewerId,
        categoryId: query.categoryId,
        search: query.search,
      },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((c) => ({
        checkId: c.id,
        workerId: c.workerId,
        workerName: c.workerName,
        applicationSubmittedAt: c.applicationSubmittedAt,
        checkType: c.checkType,
        status: c.status,
        submittedAt: c.submittedAt,
        reviewerUserId: c.reviewerUserId,
        claimedAt: c.claimedAt,
        ...this.slaView(c),
        applicationReference: c.applicationReference,
        decidedAt: this.decidedAt(c),
        uploadedDocuments: uploadedByCheck.get(c.id) ?? 0,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  startReview(checkId: string, admin: VerificationActor): Promise<AdminWorkerVerificationResponse> {
    // SUBMITTED is claimed; an IN_REVIEW check with no reviewer (after a re-check or a release) can be claimed too. Assignment is the
    // persisted reviewerUserId, never the status. Re-claiming my own check changes nothing; another reviewer's check answers 409
    // (release or reassignment by a supervisor is the way to move it).
    return this.transition(checkId, admin, {
      action: 'verification.start_review',
      from: ['SUBMITTED', 'IN_REVIEW'],
      to: 'IN_REVIEW',
      preflight: (check) => {
        if (check.status !== 'IN_REVIEW') return 'proceed';
        if (check.reviewerUserId === admin.userId) return 'skip';
        if (check.reviewerUserId !== null) {
          throw new DomainException(
            VerificationErrorCode.CHECK_ALREADY_ASSIGNED,
            'This check is already assigned to another reviewer',
            HttpStatus.CONFLICT,
          );
        }
        return 'proceed';
      },
      update: (now) => ({
        status: 'IN_REVIEW',
        reviewerUserId: admin.userId,
        claimedAt: now,
        lastActivityAt: now,
        reviewedAt: null,
      }),
    });
  }

  /** Releases a claim back to the queue (IN_REVIEW to SUBMITTED). The claiming reviewer, or a supervisor (verification.reassign). */
  releaseReview(
    checkId: string,
    dto: ReleaseReviewDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.transition(checkId, admin, {
      action: 'verification.release_review',
      from: ['IN_REVIEW'],
      to: 'SUBMITTED',
      remarks: dto.reason,
      preflight: (check) => {
        if (check.reviewerUserId === null) {
          throw new DomainException(
            VerificationErrorCode.CHECK_NOT_CLAIMED,
            'This check is not claimed by anyone',
            HttpStatus.CONFLICT,
          );
        }
        this.assertOwnerOrSupervisor(check, admin);
        return 'proceed';
      },
      metadata: (check) => ({
        previousReviewerUserId: check.reviewerUserId,
        forced: check.reviewerUserId !== admin.userId,
      }),
      update: () => ({
        status: 'SUBMITTED',
        reviewerUserId: null,
        claimedAt: null,
        lastActivityAt: null,
        reviewedAt: null,
      }),
      notifyWorker: false,
    });
  }

  /** Moves a claim (or takes an unclaimed review) to another eligible reviewer. Supervisors only (verification.reassign). */
  async reassignReview(
    checkId: string,
    dto: ReassignReviewDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    const target = await this.users.findById(dto.reviewerUserId);
    const access = target ? await this.users.getAccess(target.id) : null;
    if (
      !target ||
      target.type !== 'ADMIN' ||
      target.status !== 'ACTIVE' ||
      !access?.permissions.includes(PermissionCode.VERIFICATION_REVIEW)
    ) {
      throw new DomainException(
        VerificationErrorCode.REVIEWER_NOT_ELIGIBLE,
        'The new reviewer must be an active admin who may review verification checks',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'reviewerUserId', messages: ['not an eligible reviewer'] }],
      );
    }
    return this.transition(checkId, admin, {
      action: 'verification.reassign_review',
      from: ['IN_REVIEW'],
      to: 'IN_REVIEW',
      remarks: dto.reason,
      metadata: (check) => ({
        previousReviewerUserId: check.reviewerUserId,
        newReviewerUserId: target.id,
      }),
      update: (now) => ({
        status: 'IN_REVIEW',
        reviewerUserId: target.id,
        claimedAt: now,
        lastActivityAt: now,
      }),
      notifyWorker: false,
    });
  }

  approve(
    checkId: string,
    dto: ApproveCheckDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    const recheckAt =
      dto.recheckAt !== undefined ? this.futureDateOrFail('recheckAt', dto.recheckAt) : undefined;
    return this.transition(checkId, admin, {
      action: 'verification.approve',
      from: ['IN_REVIEW'],
      to: 'APPROVED',
      remarks: dto.remarks,
      preflight: async (check, tx) => {
        this.assertOwnerOrSupervisor(check, admin);
        await this.assertApprovalRequirements(check, tx);
        return 'proceed' as const;
      },
      update: (now, check) => ({
        status: 'APPROVED',
        reviewedAt: now,
        reviewerUserId: admin.userId,
        remarks: dto.remarks ?? null,
        // A document with a validity end is re-checked on that date unless the reviewer chose another one.
        recheckAt: recheckAt ?? check.documentExpiresOn ?? null,
        lastActivityAt: now,
      }),
      metadata: () => ({ recheckAt: recheckAt ?? null }),
    });
  }

  reject(
    checkId: string,
    dto: RejectCheckDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    if (dto.reasonCode === 'OTHER' && !dto.remarks) {
      throw this.invalidField('remarks', 'remarks are required when the reason is OTHER');
    }
    // The CHECK constraint needs remarks on a rejection: without any, the standard wording of the code is what the worker sees.
    const remarks = dto.remarks ?? REJECTION_MESSAGES[dto.reasonCode];
    return this.transition(checkId, admin, {
      action: 'verification.reject',
      from: ['IN_REVIEW'],
      to: 'REJECTED',
      remarks,
      preflight: (check) => {
        this.assertOwnerOrSupervisor(check, admin);
        return 'proceed';
      },
      update: (now) => ({
        status: 'REJECTED',
        reviewedAt: now,
        reviewerUserId: admin.userId,
        remarks,
        rejectionCode: dto.reasonCode,
        lastActivityAt: now,
      }),
      metadata: () => ({
        reasonCode: dto.reasonCode,
        terminal: TERMINAL_REJECTION_CODES.has(dto.reasonCode),
      }),
      notifyParams: { reasonCode: dto.reasonCode },
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
        claimedAt: null,
        lastActivityAt: null,
        remarks: null,
        recheckAt: null,
      }),
    });
  }

  /** A reviewer note or an employer/phone call note on a check in review (staff only; never shown to the worker). */
  async addNote(
    checkId: string,
    dto: AddNoteDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    const workerId = await this.repository.transaction(async (tx) => {
      const check = await this.requireLockedInReview(checkId, admin, tx);
      await this.repository.addNote(
        { checkId: check.id, kind: dto.kind, body: dto.body, authorUserId: admin.userId },
        tx,
      );
      await this.repository.updateCheck(
        check.id,
        { status: check.status, lastActivityAt: new Date() },
        tx,
      );
      await this.audit.record(
        {
          action: 'verification.note_add',
          entityType: 'worker_verification_check',
          entityId: check.id,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          // The note text may name people: it stays in the notes table, not in the audit log.
          metadata: { workerId: check.workerId, checkType: check.checkType, kind: dto.kind },
        },
        tx,
      );
      return check.workerId;
    });
    return this.adminView(workerId);
  }

  /**
   * The reviewer transcribes the document number and validity from the document in review. Only the last four characters of the
   * number are kept (the full number is never stored or logged).
   */
  async setDocumentDetails(
    checkId: string,
    dto: DocumentDetailsDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    if (dto.documentNumber === undefined && dto.expiresOn === undefined) {
      throw this.invalidField('documentNumber', 'send documentNumber, expiresOn or both');
    }
    const masked =
      dto.documentNumber !== undefined ? this.maskedOrFail(dto.documentNumber) : undefined;
    const expiresOn =
      dto.expiresOn !== undefined ? this.futureDateOrFail('expiresOn', dto.expiresOn) : undefined;
    const workerId = await this.repository.transaction(async (tx) => {
      const check = await this.requireLockedInReview(checkId, admin, tx);
      await this.repository.updateCheck(
        check.id,
        {
          status: check.status,
          lastActivityAt: new Date(),
          ...(masked !== undefined ? { maskedDocumentNumber: masked } : {}),
          ...(expiresOn !== undefined ? { documentExpiresOn: expiresOn } : {}),
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'verification.document_details',
          entityType: 'worker_verification_check',
          entityId: check.id,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: {
            workerId: check.workerId,
            checkType: check.checkType,
            numberSet: masked !== undefined,
            expiresOn: expiresOn ?? null,
          },
        },
        tx,
      );
      return check.workerId;
    });
    return this.adminView(workerId);
  }

  async documentLink(documentId: string, admin: VerificationActor): Promise<DocumentLinkResponse> {
    const document = await this.repository.findDocument(documentId);
    const check = document ? await this.repository.findCheckById(document.checkId) : null;
    if (!document || !check) {
      throw this.documentNotFound();
    }
    // The document exists but has no stored file to show: say why instead of a bare 404.
    if (document.status !== 'UPLOADED' || document.purgedAt) {
      throw new DomainException(
        VerificationErrorCode.DOCUMENT_NOT_AVAILABLE,
        document.purgedAt
          ? 'The stored file was discarded by the server'
          : 'The worker has not confirmed the upload of this document',
        HttpStatus.CONFLICT,
      );
    }
    // Integrity at review time: the bytes the reviewer is about to see must be the bytes that were validated at confirmation.
    // Documents confirmed before hashes were recorded have none to compare (recorded in the audit entry below).
    let integrityChecked = false;
    if (document.contentSha256) {
      const object = await this.storageCall(() =>
        this.storage.readObject(document.objectKey, document.sizeBytes),
      );
      if (object === null) {
        throw this.objectMissing();
      }
      const intact =
        object !== null &&
        !object.truncated &&
        createHash('sha256').update(object.bytes).digest('hex') === document.contentSha256;
      if (!intact) {
        await this.audit.record({
          action: 'verification.document_integrity_failed',
          entityType: 'verification_document',
          entityId: document.id,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { workerId: check.workerId, checkType: check.checkType, checkId: check.id },
        });
        throw new DomainException(
          VerificationErrorCode.DOCUMENT_INTEGRITY_FAILED,
          'The stored document no longer matches what was uploaded; it cannot be shown',
          HttpStatus.CONFLICT,
        );
      }
      integrityChecked = true;
    } else if (!(await this.storageCall(() => this.storage.getObjectInfo(document.objectKey)))) {
      throw this.objectMissing();
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
      metadata: {
        workerId: check.workerId,
        checkType: check.checkType,
        checkId: check.id,
        integrityChecked,
      },
    });
    await this.repository.touchActivity(check.id, admin.userId, new Date());
    return {
      url: link.url,
      signedUrl: link.url,
      expiresAt: link.expiresAt,
      expiresInSeconds: Math.max(0, Math.round((link.expiresAt.getTime() - Date.now()) / 1000)),
    };
  }

  /**
   * Discards an upload that failed validation: the object is deleted from storage and the document is marked purged and audited.
   * Only an UNCONFIRMED document is ever touched. If the delete itself fails the document is NOT marked, so the abandoned-upload
   * sweeper retries it; the confirmation still fails either way.
   */
  private async rejectUpload(
    document: { id: string; objectKey: string },
    check: { workerId: string; checkType: string },
    workerId: string,
    actorId: string | null,
    code: string,
  ): Promise<void> {
    try {
      await this.storage.deleteObject(document.objectKey);
      await this.repository.markPurged(document.id, code, new Date());
    } catch (error) {
      this.logger.warn(
        `Rejected upload could not be discarded now (${code}): ${(error as Error).message}`,
      );
    }
    await this.audit.record({
      action: 'verification.document_content_rejected',
      entityType: 'verification_document',
      entityId: document.id,
      actorId,
      metadata: { workerId, checkType: check.checkType, reason: code },
    });
  }

  /**
   * Sweeper for uploads that were never confirmed (the client skipped confirmation, or uploaded something it never confirmed):
   * their objects are deleted so the private bucket does not accumulate unreviewed files. Confirmed documents are never touched.
   * `olderThanMs` is an engineering default, not a retention rule.
   */
  async purgeAbandonedUploads(olderThanMs: number, limit = 50): Promise<number> {
    const documents = await this.repository.findAbandonedUploads(
      new Date(Date.now() - olderThanMs),
      limit,
    );
    let purged = 0;
    for (const document of documents) {
      try {
        await this.storage.deleteObject(document.objectKey);
        if (await this.repository.markPurged(document.id, 'ABANDONED', new Date())) {
          await this.audit.record({
            action: 'verification.document_abandoned_purged',
            entityType: 'verification_document',
            entityId: document.id,
            actorId: null,
            metadata: { reason: 'ABANDONED' },
          });
          purged++;
        }
      } catch (error) {
        this.logger.warn(`Abandoned upload not discarded: ${(error as Error).message}`);
      }
    }
    return purged;
  }

  private notUploaded(): DomainException {
    return new DomainException(
      VerificationErrorCode.DOCUMENT_NOT_UPLOADED,
      'The document has not been uploaded, or its size does not match',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  // --- final sign-off, activation, claim sweeper (D-90) -----------------------------------------------------------

  /**
   * Final verification sign-off (Q-123): every required check is approved AND a supervisor accepts the worker. Repeating it changes
   * nothing and sends nothing twice. It does not activate the worker (activation is a separate, later step).
   */
  async signOff(
    workerId: string,
    dto: SignOffDto,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    const ref = await this.workers.requireRefById(workerId);
    await this.repository.transaction(async (tx) => {
      await this.workers.lockForVerification(workerId, tx);
      const facts = await this.workers.getActivationFacts(workerId, tx);
      if (facts.onboardingStatus !== 'SUBMITTED') {
        throw new DomainException(
          VerificationErrorCode.PROFILE_NOT_SUBMITTED,
          'The worker has not submitted the profile',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (facts.signedOffAt) return;
      const checks = await this.repository.listChecks(workerId, tx);
      if (
        checks.some(
          (c) =>
            c.status === 'REJECTED' &&
            c.rejectionCode !== null &&
            TERMINAL_REJECTION_CODES.has(c.rejectionCode),
        )
      ) {
        throw new DomainException(
          VerificationErrorCode.WORKER_DISQUALIFIED,
          'A check was rejected for a disqualifying reason',
          HttpStatus.CONFLICT,
        );
      }
      if (!(await this.repository.isVerified(workerId, tx))) {
        throw new DomainException(
          VerificationErrorCode.NOT_FULLY_VERIFIED,
          'Every required check must be approved (and none due for re-check) before the sign-off',
          HttpStatus.CONFLICT,
        );
      }
      if (!(await this.workers.markSignedOff(workerId, admin.userId, new Date(), tx))) return;
      await this.audit.record(
        {
          action: 'verification.worker_signoff',
          entityType: 'worker_profile',
          entityId: workerId,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: {
            applicationReference: facts.applicationReference,
            hasRemarks: dto.remarks !== undefined,
          },
        },
        tx,
      );
      await this.outbox.notify(
        {
          event: NotificationEvent.WORKER_VERIFIED,
          recipients: [ref.userId],
          params: { applicationReference: facts.applicationReference ?? '' },
        },
        tx,
      );
      // Operations: a verified worker is waiting for activation (ids and the reference only, no personal data).
      await this.alerts.raise(
        {
          dedupeKey: `worker_verified:${workerId}`,
          type: 'WORKER_VERIFIED',
          severity: 'INFO',
          title: `Worker ${facts.applicationReference ?? workerId} is verified and ready for activation`,
          requiredPermission: PermissionCode.WORKER_ACTIVATE,
          entityType: 'worker_profile',
          entityId: workerId,
          detail: { applicationReference: facts.applicationReference },
        },
        tx,
      );
    });
    return this.adminView(workerId);
  }

  /**
   * Activation (Q-128): the signed-off worker goes live in search and matching. Needs the sign-off, every required check still
   * approved, at least one service category and one service area, the criminal self-declaration, an active account and no blacklisting.
   */
  async activate(
    workerId: string,
    admin: VerificationActor,
  ): Promise<AdminWorkerVerificationResponse> {
    const ref = await this.workers.requireRefById(workerId);
    await this.repository.transaction(async (tx) => {
      await this.workers.lockForVerification(workerId, tx);
      const facts = await this.workers.getActivationFacts(workerId, tx);
      if (facts.onboardingStatus !== 'SUBMITTED') {
        throw new DomainException(
          VerificationErrorCode.PROFILE_NOT_SUBMITTED,
          'The worker has not submitted the profile',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (facts.activatedAt) return;
      if (!facts.signedOffAt) {
        throw new DomainException(
          VerificationErrorCode.NOT_SIGNED_OFF,
          'The final verification sign-off is required before activation',
          HttpStatus.CONFLICT,
        );
      }
      const missing: string[] = [];
      if (!(await this.repository.isVerified(workerId, tx))) missing.push('verification');
      if (facts.categoryCount < 1) missing.push('serviceCategory');
      if (facts.areaCount < 1) missing.push('serviceArea');
      if (!facts.criminalDeclared) missing.push('criminalDeclaration');
      if (facts.blacklisted) missing.push('blacklisted');
      if (facts.accountStatus !== 'ACTIVE') missing.push('accountSuspended');
      if (missing.length > 0) {
        throw new DomainException(
          VerificationErrorCode.ACTIVATION_REQUIREMENTS_MISSING,
          'The worker cannot be activated yet',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: 'worker', messages: missing }],
        );
      }
      if (!(await this.workers.markActivated(workerId, admin.userId, new Date(), tx))) return;
      await this.audit.record(
        {
          action: 'worker.activate',
          entityType: 'worker_profile',
          entityId: workerId,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { applicationReference: facts.applicationReference },
        },
        tx,
      );
      await this.outbox.notify(
        {
          event: NotificationEvent.WORKER_ACTIVATED,
          recipients: [ref.userId],
          params: { applicationReference: facts.applicationReference ?? '' },
        },
        tx,
      );
    });
    return this.adminView(workerId);
  }

  /**
   * Scheduler entry (worker process): a claim with no reviewer activity for CLAIM_INACTIVITY_MINUTES goes back to SUBMITTED so another
   * reviewer can take it. Never decides anything. Claimed rows are locked (SKIP LOCKED): concurrent runs never take the same one.
   */
  async releaseInactiveClaims(limit = 50): Promise<number> {
    const before = new Date(Date.now() - CLAIM_INACTIVITY_MINUTES * 60 * 1000);
    return this.repository.transaction(async (tx) => {
      const stale = await this.repository.claimInactive(before, limit, tx);
      for (const row of stale) {
        await this.repository.updateCheck(
          row.id,
          {
            status: 'SUBMITTED',
            reviewerUserId: null,
            claimedAt: null,
            lastActivityAt: null,
            reviewedAt: null,
          },
          tx,
        );
        await this.repository.addEvent(
          {
            checkId: row.id,
            fromStatus: 'IN_REVIEW',
            toStatus: 'SUBMITTED',
            actorUserId: row.reviewerUserId,
            remarks: 'AUTO_RELEASED_INACTIVITY',
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'verification.claim_auto_released',
            entityType: 'worker_verification_check',
            entityId: row.id,
            actorId: null,
            metadata: {
              workerId: row.workerId,
              checkType: row.checkType,
              previousReviewerUserId: row.reviewerUserId,
              inactivityMinutes: CLAIM_INACTIVITY_MINUTES,
            },
          },
          tx,
        );
      }
      return stale.length;
    });
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
      preflight?: (
        check: CheckRecord,
        tx: Prisma.TransactionClient,
      ) => 'proceed' | 'skip' | Promise<'proceed' | 'skip'>;
      remarks?: string;
      metadata?: (check: CheckRecord) => Record<string, unknown>;
      /** Set false for moves the worker has no stake in (claims, releases). */
      notifyWorker?: boolean;
      notifyParams?: Record<string, string>;
      update: (
        now: Date,
        check: CheckRecord,
      ) => {
        status: StoredCheckStatus;
        reviewedAt?: Date | null;
        reviewerUserId?: string | null;
        claimedAt?: Date | null;
        lastActivityAt?: Date | null;
        rejectionCode?: CheckRecord['rejectionCode'];
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
      if (!rule.from.includes(check.status)) {
        throw new DomainException(
          VerificationErrorCode.INVALID_TRANSITION,
          `A check that is ${check.status} cannot move to ${rule.to}`,
          HttpStatus.CONFLICT,
        );
      }
      if ((await rule.preflight?.(check, tx)) === 'skip') {
        return check.workerId;
      }
      const now = new Date();
      await this.repository.updateCheck(check.id, rule.update(now, check), tx);
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
            ...rule.metadata?.(check),
          },
        },
        tx,
      );
      if (rule.notifyWorker !== false && (rule.to === 'APPROVED' || rule.to === 'REJECTED')) {
        const worker = await this.workers.requireRefById(check.workerId);
        await this.outbox.notify(
          {
            event:
              rule.to === 'APPROVED'
                ? NotificationEvent.VERIFICATION_APPROVED
                : NotificationEvent.VERIFICATION_REJECTED,
            recipients: [worker.userId],
            params: { checkType: check.checkType, ...rule.notifyParams },
          },
          tx,
        );
      }
      return check.workerId;
    });
    return this.adminView(workerId);
  }

  /** Decisions belong to the reviewer who claimed the check; a supervisor (verification.reassign) may act on any claim. */
  private assertOwnerOrSupervisor(check: CheckRecord, admin: VerificationActor): void {
    if (
      check.reviewerUserId === admin.userId ||
      admin.permissions.includes(PermissionCode.VERIFICATION_REASSIGN)
    ) {
      return;
    }
    throw new DomainException(
      VerificationErrorCode.CHECK_NOT_ASSIGNED_TO_YOU,
      check.reviewerUserId === null
        ? 'Claim this check (start-review) before acting on it'
        : 'This check is claimed by another reviewer',
      HttpStatus.CONFLICT,
    );
  }

  private async requireLockedInReview(
    checkId: string,
    admin: VerificationActor,
    tx: Prisma.TransactionClient,
  ): Promise<CheckRecord> {
    const check = await this.repository.lockCheck(checkId, tx);
    if (!check) {
      throw new DomainException(
        VerificationErrorCode.CHECK_NOT_FOUND,
        'Verification check not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (check.status !== 'IN_REVIEW') {
      throw new DomainException(
        VerificationErrorCode.INVALID_TRANSITION,
        `Only a check that is IN_REVIEW can be edited by a reviewer (this one is ${check.status})`,
        HttpStatus.CONFLICT,
      );
    }
    this.assertOwnerOrSupervisor(check, admin);
    return check;
  }

  /** Approved rules (D-90): employer call logged; police clearance reference recorded; licence and police validity end recorded. */
  private async assertApprovalRequirements(
    check: CheckRecord,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const missing: string[] = [];
    if (
      check.checkType === 'PREVIOUS_EMPLOYMENT' &&
      (await this.repository.countNotes(check.id, 'CALL', tx)) === 0
    ) {
      missing.push('callNote');
    }
    if (check.checkType === 'POLICE_VERIFICATION' && !check.maskedDocumentNumber) {
      missing.push('referenceNumber');
    }
    if (
      (check.checkType === 'LICENSE' || check.checkType === 'POLICE_VERIFICATION') &&
      (!check.documentExpiresOn || check.documentExpiresOn <= indiaToday())
    ) {
      missing.push('expiresOn');
    }
    if (missing.length > 0) {
      throw new DomainException(
        VerificationErrorCode.APPROVAL_REQUIREMENTS_MISSING,
        'This check cannot be approved yet',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'check', messages: missing }],
      );
    }
  }

  private assertNotDisqualified(check: CheckRecord): void {
    if (
      check.status === 'REJECTED' &&
      check.rejectionCode &&
      TERMINAL_REJECTION_CODES.has(check.rejectionCode)
    ) {
      throw new DomainException(
        VerificationErrorCode.CHECK_DISQUALIFIED,
        'This check was rejected for a disqualifying reason and cannot be resubmitted',
        HttpStatus.CONFLICT,
      );
    }
  }

  private maskedOrFail(raw: string): string {
    const masked = maskDocumentNumber(raw);
    if (!masked) throw this.invalidField('documentNumber', 'documentNumber is too short');
    return masked;
  }

  /** A real calendar date in YYYY-MM-DD form that is still in the future (India date). */
  private futureDateOrFail(field: string, value: string): string {
    const valid = !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
    if (!valid || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      throw this.invalidField(field, `${field} is not a real date`);
    }
    if (value <= indiaToday()) {
      throw this.invalidField(field, `${field} must be a future date`);
    }
    return value;
  }

  private slaView(c: Pick<CheckRecord, 'status' | 'submittedAt' | 'claimedAt' | 'reviewerUserId'>) {
    const sla = slaOf(c);
    return {
      dueAt: sla.dueAt,
      claimDueAt: sla.claimDueAt,
      slaFlags: sla.flags,
      isOverdue: sla.flags.includes('OVERDUE'),
    };
  }

  private decidedAt(c: Pick<CheckRecord, 'status' | 'reviewedAt'>): Date | null {
    return c.status === 'APPROVED' || c.status === 'REJECTED' ? c.reviewedAt : null;
  }

  /**
   * Overall status (D-90), derived. DRAFT before the profile is submitted; REJECTED when a check was rejected for a disqualifying
   * reason; VERIFIED / ACTIVE need every required check approved plus the stored sign-off / activation; ACTION_REQUIRED while a
   * non-disqualifying rejection waits for the worker; UNDER_REVIEW once any check was submitted; SUBMITTED before that.
   */
  private applicationStatusOf(input: {
    onboardingStatus: string;
    checks: CheckRecord[];
    level: VerificationLevel;
    signedOffAt: Date | null;
    activatedAt: Date | null;
  }): ApplicationStatus {
    if (input.onboardingStatus !== 'SUBMITTED') return 'DRAFT';
    if (
      input.checks.some(
        (c) =>
          c.status === 'REJECTED' &&
          c.rejectionCode !== null &&
          TERMINAL_REJECTION_CODES.has(c.rejectionCode),
      )
    ) {
      return 'REJECTED';
    }
    if (input.level === 'VERIFIED' && input.signedOffAt) {
      return input.activatedAt ? 'ACTIVE' : 'VERIFIED';
    }
    if (input.checks.some((c) => c.status === 'REJECTED')) return 'ACTION_REQUIRED';
    if (input.checks.some((c) => c.status !== 'NOT_SUBMITTED')) return 'UNDER_REVIEW';
    return 'SUBMITTED';
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

  private adminDocumentView(document: DocumentRecord, documentType: CheckType): AdminDocumentView {
    const availability =
      document.status === 'UPLOADED' && !document.purgedAt
        ? 'AVAILABLE'
        : document.purgedAt
          ? 'DISCARDED'
          : 'NOT_UPLOADED';
    return {
      ...this.documentView(document),
      documentId: document.id,
      documentType,
      mimeType: document.contentType,
      availability,
      available: availability === 'AVAILABLE',
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
      const code = check?.status === 'REJECTED' ? (check.rejectionCode ?? null) : null;
      return {
        checkType,
        status: effectiveStatus(check, today),
        required: required.includes(checkType),
        submittedAt: check?.submittedAt ?? null,
        reviewedAt: check?.reviewedAt ?? null,
        remarks: check?.remarks ?? null,
        rejectionCode: code,
        rejectionMessage: code ? REJECTION_MESSAGES[code] : null,
        terminal: code !== null && TERMINAL_REJECTION_CODES.has(code),
        maskedDocumentNumber: check?.maskedDocumentNumber ?? null,
        documentExpiresOn: check?.documentExpiresOn ?? null,
        recheckAt: check?.recheckAt ?? null,
        documents: check
          ? documents.filter((d) => d.checkId === check.id).map((d) => this.documentView(d))
          : [],
      };
    });
  }

  private async workerView(workerId: string): Promise<WorkerVerificationResponse> {
    const today = indiaToday();
    const [required, checks, ref] = await Promise.all([
      this.repository.getRequirements(),
      this.repository.listChecks(workerId),
      this.workers.requireRefById(workerId),
    ]);
    const documents = await this.repository.listDocuments(checks.map((c) => c.id));
    const level = this.levelOf(required, checks, today);
    return {
      applicationReference: ref.applicationReference,
      applicationStatus: this.applicationStatusOf({
        onboardingStatus: ref.onboardingStatus,
        checks,
        level,
        signedOffAt: ref.signedOffAt,
        activatedAt: ref.activatedAt,
      }),
      level,
      requiredChecks: required,
      checks: this.checkViews(required, checks, documents, today),
    };
  }

  private async adminView(workerId: string): Promise<AdminWorkerVerificationResponse> {
    const today = indiaToday();
    const [required, checks, ref] = await Promise.all([
      this.repository.getRequirements(),
      this.repository.listChecks(workerId),
      this.workers.requireRefById(workerId),
    ]);
    const [documents, events, notes] = await Promise.all([
      this.repository.listDocuments(checks.map((c) => c.id)),
      this.repository.listEvents(checks.map((c) => c.id)),
      this.repository.listNotes(checks.map((c) => c.id)),
    ]);
    const views = this.checkViews(required, checks, documents, today);
    const byType = new Map(checks.map((c) => [c.checkType, c]));
    const eventsByCheck = new Map<string, EventRecord[]>();
    for (const e of events) {
      eventsByCheck.set(e.checkId, [...(eventsByCheck.get(e.checkId) ?? []), e]);
    }
    const adminChecks: AdminCheckView[] = views.map((view) => {
      const check = byType.get(view.checkType);
      const sla = check
        ? this.slaView(check)
        : { dueAt: null, claimDueAt: null, slaFlags: [] as never[], isOverdue: false };
      return {
        ...view,
        documents: check
          ? documents
              .filter((d) => d.checkId === check.id)
              .map((d) => this.adminDocumentView(d, view.checkType))
          : [],
        checkId: check?.id ?? '',
        reviewerUserId: check?.reviewerUserId ?? null,
        claimedAt: check?.claimedAt ?? null,
        lastActivityAt: check?.lastActivityAt ?? null,
        dueAt: sla.dueAt,
        claimDueAt: sla.claimDueAt,
        slaFlags: sla.slaFlags,
        decidedAt: check ? this.decidedAt(check) : null,
        notes: notes
          .filter((n) => check && n.checkId === check.id)
          .map((n) => ({
            id: n.id,
            kind: n.kind,
            body: n.body,
            authorUserId: n.authorUserId,
            createdAt: n.createdAt,
          })),
        history: (check ? (eventsByCheck.get(check.id) ?? []) : []).map((e) => ({
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          actorUserId: e.actorUserId,
          remarks: e.remarks,
          createdAt: e.createdAt,
        })),
      };
    });
    const level = this.levelOf(required, checks, today);
    return {
      workerId,
      applicationReference: ref.applicationReference,
      applicationStatus: this.applicationStatusOf({
        onboardingStatus: ref.onboardingStatus,
        checks,
        level,
        signedOffAt: ref.signedOffAt,
        activatedAt: ref.activatedAt,
      }),
      signedOffAt: ref.signedOffAt,
      activatedAt: ref.activatedAt,
      level,
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

  private objectMissing(): DomainException {
    return new DomainException(
      VerificationErrorCode.DOCUMENT_OBJECT_MISSING,
      'The file for this document is not in storage',
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
