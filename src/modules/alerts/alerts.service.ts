import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { Page, skipFor } from '../../common/pagination/pagination';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { UsersService } from '../users/users.service';
import type { AlertListQuery, AlertView } from './alerts.dto';

type Db = Prisma.TransactionClient | PrismaService;

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface NewAlert {
  /** One open alert per key: raising it again only counts another occurrence. Use `type:entityId`. */
  dedupeKey: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  /** Permission a viewer needs to see this alert; null = any admin who may view alerts. */
  requiredPermission?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Ids, counts and stable codes only: never personal data. */
  detail?: Record<string, unknown>;
}

export const AlertErrorCode = {
  ALERT_NOT_FOUND: 'ALERT_NOT_FOUND',
  ALERT_ALREADY_RESOLVED: 'ALERT_ALREADY_RESOLVED',
} as const;

export interface StaffActor {
  userId: string;
  roles: string[];
}

type Row = Prisma.AdminAlertGetPayload<object>;

function toView(row: Row): AlertView {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    title: row.title,
    entityType: row.entityType,
    entityId: row.entityId,
    detail: (row.detail as Record<string, unknown> | null) ?? null,
    occurrences: row.occurrences,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    acknowledgedAt: row.acknowledgedAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
  };
}

/**
 * Operational alerts for staff (PRD 13 monitoring and alerts; the FRD's "admin is alerted"). Raised by scheduled jobs and by money
 * problems, deduplicated per (type, entity), visible only to admins holding the alert's required permission, and resolved by a
 * person or automatically when the underlying problem is gone. An alert never changes the thing it is about.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly users: UsersService,
  ) {}

  /** Raises (or re-counts) an alert. Pass the caller's transaction so the alert exists if and only if the change committed. */
  async raise(input: NewAlert, db: Db = this.prisma): Promise<void> {
    await db.$executeRaw`
      INSERT INTO admin_alerts (id, dedupe_key, type, severity, required_permission, entity_type, entity_id, title, detail)
      VALUES (gen_random_uuid(), ${input.dedupeKey}, ${input.type}, ${input.severity}::"AdminAlertSeverity",
              ${input.requiredPermission ?? null}, ${input.entityType ?? null}, ${input.entityId ?? null}, ${input.title},
              ${input.detail ? JSON.stringify(input.detail) : null}::jsonb)
      ON CONFLICT (dedupe_key) DO UPDATE SET
        occurrences = admin_alerts.occurrences + 1,
        last_seen_at = now(),
        severity = EXCLUDED.severity,
        detail = EXCLUDED.detail,
        status = CASE WHEN admin_alerts.status = 'RESOLVED' THEN 'OPEN'::"AdminAlertStatus" ELSE admin_alerts.status END,
        resolved_at = CASE WHEN admin_alerts.status = 'RESOLVED' THEN NULL ELSE admin_alerts.resolved_at END,
        resolved_by = CASE WHEN admin_alerts.status = 'RESOLVED' THEN NULL ELSE admin_alerts.resolved_by END,
        resolution_note = CASE WHEN admin_alerts.status = 'RESOLVED' THEN NULL ELSE admin_alerts.resolution_note END`;
  }

  /** The underlying problem is gone: closes the alert without a person. No-op when there is none or it is already resolved. */
  async autoResolve(dedupeKey: string, note: string, db: Db = this.prisma): Promise<void> {
    await db.$executeRaw`
      UPDATE admin_alerts SET status = 'RESOLVED', resolved_at = now(), resolution_note = ${note}
      WHERE dedupe_key = ${dedupeKey} AND status <> 'RESOLVED'`;
  }

  async list(query: AlertListQuery, actor: StaffActor): Promise<Page<AlertView>> {
    const visible = await this.visibility(actor.userId);
    const where: Prisma.AdminAlertWhereInput = {
      AND: [
        visible,
        query.status ? { status: query.status } : { status: { not: 'RESOLVED' } },
        ...(query.severity ? [{ severity: query.severity }] : []),
        ...(query.type ? [{ type: query.type }] : []),
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.adminAlert.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(query),
        take: query.limit,
      }),
      this.prisma.adminAlert.count({ where }),
    ]);
    return { data: rows.map(toView), meta: { page: query.page, limit: query.limit, total } };
  }

  async summary(
    actor: StaffActor,
  ): Promise<{ open: number; bySeverity: Record<AlertSeverity, number> }> {
    const visible = await this.visibility(actor.userId);
    const groups = await this.prisma.adminAlert.groupBy({
      by: ['severity'],
      where: { AND: [visible, { status: { not: 'RESOLVED' } }] },
      _count: { _all: true },
    });
    const bySeverity: Record<AlertSeverity, number> = { INFO: 0, WARNING: 0, CRITICAL: 0 };
    for (const g of groups) bySeverity[g.severity] = g._count._all;
    return { open: bySeverity.INFO + bySeverity.WARNING + bySeverity.CRITICAL, bySeverity };
  }

  async acknowledge(id: string, actor: StaffActor): Promise<AlertView> {
    return this.change(id, actor, 'alert.acknowledge', async (tx) => {
      await tx.adminAlert.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedBy: actor.userId },
      });
    });
  }

  async resolve(id: string, note: string, actor: StaffActor): Promise<AlertView> {
    return this.change(id, actor, 'alert.resolve', async (tx) => {
      const done = await tx.adminAlert.updateMany({
        where: { id, status: { not: 'RESOLVED' } },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedBy: actor.userId,
          resolutionNote: note,
        },
      });
      if (done.count === 0) {
        throw new DomainException(
          AlertErrorCode.ALERT_ALREADY_RESOLVED,
          'This alert is already resolved',
          HttpStatus.CONFLICT,
        );
      }
    });
  }

  // --- internals -----------------------------------------------------------------------------------------------

  private async change(
    id: string,
    actor: StaffActor,
    action: string,
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<AlertView> {
    const visible = await this.visibility(actor.userId);
    await this.prisma.$transaction(async (tx) => {
      const alert = await tx.adminAlert.findFirst({ where: { AND: [{ id }, visible] } });
      // An alert the admin may not see answers exactly like an unknown one.
      if (!alert) {
        throw new DomainException(
          AlertErrorCode.ALERT_NOT_FOUND,
          'Alert not found',
          HttpStatus.NOT_FOUND,
        );
      }
      await work(tx);
      await this.audit.record(
        {
          action,
          entityType: 'admin_alert',
          entityId: id,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: { type: alert.type },
        },
        tx,
      );
    });
    return toView(await this.prisma.adminAlert.findUniqueOrThrow({ where: { id } }));
  }

  private async visibility(userId: string): Promise<Prisma.AdminAlertWhereInput> {
    const access = await this.users.getAccess(userId);
    return {
      OR: [{ requiredPermission: null }, { requiredPermission: { in: access.permissions } }],
    };
  }
}
