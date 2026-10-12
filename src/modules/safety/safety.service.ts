import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { Page, skipFor } from '../../common/pagination/pagination';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { BookingService } from '../booking/booking.service';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import type {
  AdminBlockView,
  AdminCreateBlockDto,
  AdminListQuery,
  AdminReportView,
  BlockView,
  CreateBlockDto,
  CreateReportDto,
  ReportView,
} from './safety.dto';

export const SafetyErrorCode = {
  TARGET_NOT_FOUND: 'SAFETY_TARGET_NOT_FOUND',
  TARGET_REQUIRED: 'SAFETY_TARGET_REQUIRED',
  BLOCK_NOT_FOUND: 'BLOCK_NOT_FOUND',
  BLOCK_ADMIN_APPLIED: 'BLOCK_ADMIN_APPLIED',
  USER_INVALID: 'SAFETY_USER_INVALID',
} as const;

export interface SafetyActor {
  userId: string;
  kind: 'CUSTOMER' | 'WORKER';
}

export interface StaffActor {
  userId: string;
  roles: string[];
}

/**
 * Report and block (PRD 9.1). A BLOCK is symmetric in effect: neither side can be matched with, find, or book the other
 * (enforced in the one eligibility query that Search, Matching, Booking and Replacement share). A REPORT is the reporter's account of
 * an incident: it is stored with a stable reason code, raises a staff alert (support.view holders) and can block at the same time.
 * Both only ever refer to people the reporter has a real relationship with: a worker they can see/book or a booking they are a
 * party to. Staff can apply and lift blocks too (audited); a block applied by staff cannot be lifted by the user.
 */
@Injectable()
export class SafetyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
    private readonly bookings: BookingService,
    private readonly workers: WorkersService,
    private readonly users: UsersService,
  ) {}

  // --- blocks ----------------------------------------------------------------------------------------------------

  async block(actor: SafetyActor, dto: CreateBlockDto): Promise<BlockView> {
    const target = await this.resolveTarget(actor, dto);
    const id = await this.prisma.$transaction((tx) =>
      this.insertBlock(actor.userId, target.userId, dto.reason ?? null, false, tx),
    );
    return this.blockView(id, actor.kind === 'CUSTOMER' ? target.workerId : null);
  }

  async listMine(actor: SafetyActor): Promise<BlockView[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerUserId: actor.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const views: BlockView[] = [];
    for (const row of rows) {
      let workerId: string | null = null;
      if (actor.kind === 'CUSTOMER') {
        workerId = (await this.workers.findRefByUserId(row.blockedUserId))?.workerId ?? null;
      }
      views.push({ id: row.id, workerId, createdAt: row.createdAt });
    }
    return views;
  }

  async unblock(actor: SafetyActor, blockId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const block = await tx.userBlock.findFirst({
        where: { id: blockId, blockerUserId: actor.userId },
      });
      if (!block) throw this.blockNotFound();
      if (block.createdByAdmin) {
        throw new DomainException(
          SafetyErrorCode.BLOCK_ADMIN_APPLIED,
          'This block was applied by our team and can only be lifted by them',
          HttpStatus.CONFLICT,
        );
      }
      await tx.userBlock.delete({ where: { id: blockId } });
      await this.audit.record(
        {
          action: 'safety.unblock',
          entityType: 'user_block',
          entityId: blockId,
          actorId: actor.userId,
          metadata: {},
        },
        tx,
      );
    });
  }

  // --- reports ---------------------------------------------------------------------------------------------------

  async report(actor: SafetyActor, dto: CreateReportDto): Promise<ReportView> {
    const target = await this.resolveTarget(actor, dto);
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.safetyReport.create({
        data: {
          reporterUserId: actor.userId,
          targetUserId: target.userId,
          bookingId: dto.bookingId ?? null,
          reasonCode: dto.reasonCode,
          note: dto.note ?? null,
        },
      });
      await this.audit.record(
        {
          action: 'safety.report',
          entityType: 'safety_report',
          entityId: report.id,
          actorId: actor.userId,
          // The note is free text from the reporter: it stays out of the audit log.
          metadata: { reasonCode: dto.reasonCode, bookingId: dto.bookingId ?? null },
        },
        tx,
      );
      await this.alerts.raise(
        {
          dedupeKey: `SAFETY_REPORT:${report.id}`,
          type: 'SAFETY_REPORT',
          severity: dto.reasonCode === 'SAFETY_CONCERN' ? 'CRITICAL' : 'WARNING',
          title: 'A safety report was filed',
          requiredPermission: PermissionCode.SUPPORT_VIEW,
          entityType: 'safety_report',
          entityId: report.id,
          detail: { reasonCode: dto.reasonCode },
        },
        tx,
      );
      if (dto.alsoBlock) {
        await this.insertBlock(actor.userId, target.userId, dto.reasonCode, false, tx);
      }
      return { id: report.id, reasonCode: report.reasonCode, createdAt: report.createdAt };
    });
  }

  // --- staff -----------------------------------------------------------------------------------------------------

  async adminListReports(query: AdminListQuery): Promise<Page<AdminReportView>> {
    const where: Prisma.SafetyReportWhereInput = query.userId
      ? { OR: [{ reporterUserId: query.userId }, { targetUserId: query.userId }] }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.safetyReport.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(query),
        take: query.limit,
      }),
      this.prisma.safetyReport.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        reasonCode: r.reasonCode,
        createdAt: r.createdAt,
        reporterUserId: r.reporterUserId,
        targetUserId: r.targetUserId,
        bookingId: r.bookingId,
        note: r.note,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminListBlocks(query: AdminListQuery): Promise<Page<AdminBlockView>> {
    const where: Prisma.UserBlockWhereInput = query.userId
      ? { OR: [{ blockerUserId: query.userId }, { blockedUserId: query.userId }] }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.userBlock.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(query),
        take: query.limit,
      }),
      this.prisma.userBlock.count({ where }),
    ]);
    return {
      data: rows.map((b) => ({
        id: b.id,
        blockerUserId: b.blockerUserId,
        blockedUserId: b.blockedUserId,
        reason: b.reason,
        createdByAdmin: b.createdByAdmin,
        createdAt: b.createdAt,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminBlock(dto: AdminCreateBlockDto, admin: StaffActor): Promise<AdminBlockView> {
    if (dto.blockerUserId === dto.blockedUserId) throw this.userInvalid();
    for (const id of [dto.blockerUserId, dto.blockedUserId]) {
      const user = await this.users.getByIdOrThrow(id).catch(() => null);
      if (!user || user.type === 'ADMIN') throw this.userInvalid();
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await this.insertBlock(
        dto.blockerUserId,
        dto.blockedUserId,
        dto.reason,
        true,
        tx,
      );
      await this.audit.record(
        {
          action: 'safety.admin_block',
          entityType: 'user_block',
          entityId: created,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { blockerUserId: dto.blockerUserId, blockedUserId: dto.blockedUserId },
        },
        tx,
      );
      return created;
    });
    const row = await this.prisma.userBlock.findUniqueOrThrow({ where: { id } });
    return {
      id: row.id,
      blockerUserId: row.blockerUserId,
      blockedUserId: row.blockedUserId,
      reason: row.reason,
      createdByAdmin: row.createdByAdmin,
      createdAt: row.createdAt,
    };
  }

  async adminUnblock(blockId: string, admin: StaffActor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const block = await tx.userBlock.findUnique({ where: { id: blockId } });
      if (!block) throw this.blockNotFound();
      await tx.userBlock.delete({ where: { id: blockId } });
      await this.audit.record(
        {
          action: 'safety.admin_unblock',
          entityType: 'user_block',
          entityId: blockId,
          actorId: admin.userId,
          actorRole: admin.roles.join(',') || null,
          metadata: { blockerUserId: block.blockerUserId, blockedUserId: block.blockedUserId },
        },
        tx,
      );
    });
  }

  // --- internals -------------------------------------------------------------------------------------------------

  private async insertBlock(
    blockerUserId: string,
    blockedUserId: string,
    reason: string | null,
    byAdmin: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    // One statement: a repeat is harmless (and a staff-applied block upgrades a user-made one), and nothing aborts the transaction.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO user_blocks (id, blocker_user_id, blocked_user_id, reason, created_by_admin)
      VALUES (gen_random_uuid(), ${blockerUserId}::uuid, ${blockedUserId}::uuid, ${reason}, ${byAdmin})
      ON CONFLICT (blocker_user_id, blocked_user_id)
      DO UPDATE SET created_by_admin = user_blocks.created_by_admin OR EXCLUDED.created_by_admin
      RETURNING id`;
    const id = rows[0].id;
    await this.audit.record(
      {
        action: 'safety.block',
        entityType: 'user_block',
        entityId: id,
        actorId: blockerUserId,
        metadata: { byAdmin },
      },
      tx,
    );
    return id;
  }

  /**
   * Who is the other party? A customer names a worker (reference) or a booking of theirs; a worker names a booking they work on.
   * Anything the caller has no relationship with answers like an unknown target.
   */
  private async resolveTarget(
    actor: SafetyActor,
    dto: { workerId?: string; bookingId?: string },
  ): Promise<{ userId: string; workerId: string | null }> {
    if (!dto.workerId && !dto.bookingId) {
      throw new DomainException(
        SafetyErrorCode.TARGET_REQUIRED,
        'Say who: give a workerId or a bookingId',
        HttpStatus.BAD_REQUEST,
        [{ field: 'bookingId', messages: ['workerId or bookingId is required'] }],
      );
    }
    if (dto.bookingId) {
      const booking = await this.bookings.getSummary(dto.bookingId).catch(() => null);
      if (actor.kind === 'CUSTOMER') {
        if (!booking || booking.customerUserId !== actor.userId || !booking.workerId) {
          throw this.targetNotFound();
        }
        const worker = await this.workers.requireRefById(booking.workerId);
        return { userId: worker.userId, workerId: booking.workerId };
      }
      const ref = await this.workers.findRefByUserId(actor.userId);
      if (!booking || !ref || booking.workerId !== ref.workerId) throw this.targetNotFound();
      return { userId: booking.customerUserId, workerId: null };
    }
    if (actor.kind !== 'CUSTOMER') throw this.targetNotFound();
    const worker = await this.workers.requireRefById(dto.workerId!).catch(() => null);
    if (!worker) throw this.targetNotFound();
    return { userId: worker.userId, workerId: dto.workerId! };
  }

  private async blockView(id: string, workerId: string | null): Promise<BlockView> {
    const row = await this.prisma.userBlock.findUniqueOrThrow({ where: { id } });
    return { id: row.id, workerId, createdAt: row.createdAt };
  }

  private targetNotFound(): DomainException {
    return new DomainException(SafetyErrorCode.TARGET_NOT_FOUND, 'Not found', HttpStatus.NOT_FOUND);
  }

  private blockNotFound(): DomainException {
    return new DomainException(
      SafetyErrorCode.BLOCK_NOT_FOUND,
      'Block not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private userInvalid(): DomainException {
    return new DomainException(
      SafetyErrorCode.USER_INVALID,
      'Both users must be different customer or worker accounts',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
