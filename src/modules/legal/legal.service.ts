import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { Page, skipFor } from '../../common/pagination/pagination';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { PermissionCode } from '../users/rbac.constants';
import type {
  AcceptLegalDto,
  DeletionListQuery,
  DeletionRequestView,
  LegalCurrentView,
  LegalStatusView,
} from './legal.dto';

export const LegalErrorCode = {
  LEGAL_ACCEPTANCE_REQUIRED: 'LEGAL_ACCEPTANCE_REQUIRED',
  LEGAL_VERSION_MISMATCH: 'LEGAL_VERSION_MISMATCH',
  LEGAL_NOT_CONFIGURED: 'LEGAL_NOT_CONFIGURED',
  DELETION_BLOCKED: 'DELETION_BLOCKED',
  DELETION_NOT_FOUND: 'DELETION_REQUEST_NOT_FOUND',
} as const;

/** Bookings in these states are finished; anything else is a live engagement that blocks account deletion. */
const FINISHED_BOOKING = ['COMPLETED', 'CANCELLED', 'REPLACED'];

/**
 * Terms/privacy consent (PRD 13) and account-deletion requests. The document versions come from configuration (the legal text is
 * reviewed outside this system, PRD 13): with none configured nothing is asked or enforced. Acceptance is append-only evidence.
 * A deletion request is RECORDED and staff are alerted; nothing is erased automatically because the retention rules are undecided
 * (Q-02) and payment/audit records must never be deleted.
 */
@Injectable()
export class LegalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
  ) {}

  current(): LegalCurrentView {
    const legal = this.config.legal;
    return {
      acceptanceRequired: legal.required && !!legal.termsVersion && !!legal.privacyVersion,
      terms: legal.termsVersion
        ? { version: legal.termsVersion, url: legal.termsUrl ?? null }
        : null,
      privacy: legal.privacyVersion
        ? { version: legal.privacyVersion, url: legal.privacyUrl ?? null }
        : null,
    };
  }

  async status(userId: string): Promise<LegalStatusView> {
    const missing = await this.missing(userId);
    return {
      acceptanceRequired: this.current().acceptanceRequired,
      accepted: missing.length === 0,
      missing,
    };
  }

  async accept(userId: string, dto: AcceptLegalDto): Promise<LegalStatusView> {
    const legal = this.config.legal;
    if (!legal.termsVersion && !legal.privacyVersion) {
      throw new DomainException(
        LegalErrorCode.LEGAL_NOT_CONFIGURED,
        'No legal documents are published yet',
        HttpStatus.CONFLICT,
      );
    }
    const wanted: Array<['TERMS' | 'PRIVACY', string | undefined, string | undefined]> = [
      ['TERMS', dto.termsVersion, legal.termsVersion],
      ['PRIVACY', dto.privacyVersion, legal.privacyVersion],
    ];
    for (const [, given, current] of wanted) {
      // Accepting an old version is refused: the user must see the current text.
      if (given !== undefined && given !== current) {
        throw new DomainException(
          LegalErrorCode.LEGAL_VERSION_MISMATCH,
          'That is not the current version of the document',
          HttpStatus.CONFLICT,
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      for (const [type, given] of wanted) {
        if (given === undefined) continue;
        await tx.$executeRaw`
          INSERT INTO legal_acceptances (id, user_id, document_type, version)
          VALUES (gen_random_uuid(), ${userId}::uuid, ${type}, ${given})
          ON CONFLICT (user_id, document_type, version) DO NOTHING`;
      }
      await this.audit.record(
        {
          action: 'legal.accept',
          entityType: 'user',
          entityId: userId,
          actorId: userId,
          metadata: {
            termsVersion: dto.termsVersion ?? null,
            privacyVersion: dto.privacyVersion ?? null,
          },
        },
        tx,
      );
    });
    return this.status(userId);
  }

  /** Booking and similar commitments require the current versions to be accepted - only when the business turned that on. */
  async assertAccepted(userId: string): Promise<void> {
    if (!this.current().acceptanceRequired) return;
    const missing = await this.missing(userId);
    if (missing.length > 0) {
      throw new DomainException(
        LegalErrorCode.LEGAL_ACCEPTANCE_REQUIRED,
        'Please accept the current terms and privacy policy to continue',
        HttpStatus.FORBIDDEN,
        [{ field: 'legal', messages: missing.map((m) => `${m} not accepted`) }],
      );
    }
  }

  // --- account deletion ----------------------------------------------------------------------------------------

  async requestDeletion(userId: string, reason?: string): Promise<DeletionRequestView> {
    const existing = await this.openRequest(userId);
    if (existing) return existing; // idempotent: one open request per user
    const blockers = await this.deletionBlockers(userId);
    if (blockers.length > 0) {
      throw new DomainException(
        LegalErrorCode.DELETION_BLOCKED,
        'The account cannot be deleted right now',
        HttpStatus.CONFLICT,
        [{ field: 'account', messages: blockers }],
      );
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.deletionRequest.create({ data: { userId, reason: reason ?? null } });
      await this.audit.record(
        {
          action: 'account.deletion_requested',
          entityType: 'user',
          entityId: userId,
          actorId: userId,
          metadata: { requestId: row.id },
        },
        tx,
      );
      await this.alerts.raise(
        {
          dedupeKey: `DELETION_REQUEST:${row.id}`,
          type: 'DELETION_REQUEST',
          severity: 'INFO',
          title: 'An account deletion was requested',
          requiredPermission: PermissionCode.USER_STATUS_MANAGE,
          entityType: 'user',
          entityId: userId,
          detail: { requestId: row.id },
        },
        tx,
      );
      return row;
    });
    return this.toView(created);
  }

  async cancelDeletion(userId: string): Promise<void> {
    const open = await this.prisma.deletionRequest.findFirst({
      where: { userId, status: 'REQUESTED' },
    });
    if (!open) {
      throw new DomainException(
        LegalErrorCode.DELETION_NOT_FOUND,
        'There is no open deletion request',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.deletionRequest.update({
        where: { id: open.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await this.alerts.autoResolve(`DELETION_REQUEST:${open.id}`, 'cancelled by the user', tx);
      await this.audit.record(
        {
          action: 'account.deletion_cancelled',
          entityType: 'user',
          entityId: userId,
          actorId: userId,
          metadata: { requestId: open.id },
        },
        tx,
      );
    });
  }

  async myDeletion(userId: string): Promise<DeletionRequestView | null> {
    return this.openRequest(userId);
  }

  async adminListDeletions(query: DeletionListQuery): Promise<Page<DeletionRequestView>> {
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.deletionRequest.findMany({
        where,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(query),
        take: query.limit,
      }),
      this.prisma.deletionRequest.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.toView(r)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  // --- internals -----------------------------------------------------------------------------------------------

  private async missing(userId: string): Promise<string[]> {
    const legal = this.config.legal;
    const missing: string[] = [];
    const accepted = await this.prisma.legalAcceptance.findMany({
      where: { userId },
      select: { documentType: true, version: true },
    });
    const has = (type: string, version: string): boolean =>
      accepted.some((a) => a.documentType === type && a.version === version);
    if (legal.termsVersion && !has('TERMS', legal.termsVersion)) missing.push('TERMS');
    if (legal.privacyVersion && !has('PRIVACY', legal.privacyVersion)) missing.push('PRIVACY');
    return missing;
  }

  private async openRequest(userId: string): Promise<DeletionRequestView | null> {
    const row = await this.prisma.deletionRequest.findFirst({
      where: { userId, status: 'REQUESTED' },
    });
    return row ? this.toView(row) : null;
  }

  /** Live engagements and money in flight that must be settled first. Reasons are generic: no booking or payment ids. */
  private async deletionBlockers(userId: string): Promise<string[]> {
    const blockers: string[] = [];
    const [bookings] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM bookings b
      LEFT JOIN worker_profiles wp ON wp.id = b.worker_id
      WHERE (b.customer_user_id = ${userId}::uuid OR wp.user_id = ${userId}::uuid)
        AND b.status::text <> ALL(${FINISHED_BOOKING})`;
    if (Number(bookings?.n ?? 0) > 0) blockers.push('You have a booking that is not finished');
    const [payments] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM payments
      WHERE customer_user_id = ${userId}::uuid
        AND status IN ('CREATED', 'PENDING', 'REFUND_PENDING', 'REFUND_FAILED')`;
    if (Number(payments?.n ?? 0) > 0) blockers.push('You have a payment or refund in progress');
    return blockers;
  }

  private toView(row: {
    id: string;
    status: 'REQUESTED' | 'CANCELLED' | 'COMPLETED';
    requestedAt: Date;
    cancelledAt: Date | null;
    completedAt: Date | null;
    userId: string;
  }): DeletionRequestView {
    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      requestedAt: row.requestedAt,
      cancelledAt: row.cancelledAt,
      completedAt: row.completedAt,
    };
  }
}
