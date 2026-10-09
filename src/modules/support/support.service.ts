import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { NotificationEvent } from '../../common/outbox/notification-events';
import { OutboxService } from '../../common/outbox/outbox.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import type { Prisma } from '../../generated/prisma/client';
import { BookingService } from '../booking/booking.service';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import {
  AdminSupportCategoryView,
  AdminTicketDetailView,
  AdminTicketListQuery,
  AdminTicketView,
  CreateSupportCategoryDto,
  CreateTicketDto,
  MyTicketListQuery,
  SupportCategoryView,
  TicketDetailView,
  TicketPriorityValue,
  TicketView,
  UpdateSupportCategoryDto,
} from './dto/support.dto';
import {
  CategoryRecord,
  SupportRepository,
  TicketEventRecord,
  TicketRecord,
} from './support.repository';

export const SupportErrorCode = {
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  CATEGORY_NOT_FOUND: 'SUPPORT_CATEGORY_NOT_FOUND',
  CATEGORY_INVALID: 'SUPPORT_CATEGORY_INVALID',
  CATEGORY_CODE_TAKEN: 'SUPPORT_CATEGORY_CODE_TAKEN',
  TICKET_CLOSED: 'TICKET_CLOSED',
  ASSIGNEE_INVALID: 'ASSIGNEE_INVALID',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
} as const;

export interface TicketCreator {
  userId: string;
  kind: 'CUSTOMER' | 'WORKER';
}

export interface StaffActor {
  userId: string;
  roles: string[];
}

/**
 * Support tickets and complaints (SRS 3.14, FRD FM-12). A customer or a worker raises a ticket with a configured category and
 * a description, optionally about one of THEIR OWN bookings; staff (`support.view` / `support.manage`) assign, prioritise,
 * escalate and close it, recording the resolution. Every transition locks the ticket row, appends an immutable history line
 * and an audit record in the same transaction, and tells the ticket creator. No SLA, auto-assignment, auto-escalation,
 * attachments, chat or report/block effect is built: the specification gives no values or rules for them (Q-59).
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly repository: SupportRepository,
    private readonly bookings: BookingService,
    private readonly workers: WorkersService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // --- categories --------------------------------------------------------------------------------------------

  async listCategories(): Promise<SupportCategoryView[]> {
    const categories = await this.repository.listCategories(true);
    return categories.map(({ id, code, name }) => ({ id, code, name }));
  }

  async adminListCategories(): Promise<AdminSupportCategoryView[]> {
    return this.repository.listCategories(false);
  }

  async createCategory(
    dto: CreateSupportCategoryDto,
    actor: StaffActor,
  ): Promise<AdminSupportCategoryView> {
    try {
      return await this.repository.transaction(async (tx) => {
        const created = await this.repository.createCategory(
          { code: dto.code, name: dto.name },
          tx,
        );
        await this.audit.record(
          {
            action: 'support_category.create',
            entityType: 'support_category',
            entityId: created.id,
            actorId: actor.userId,
            actorRole: actor.roles.join(',') || null,
            metadata: { code: created.code },
          },
          tx,
        );
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          SupportErrorCode.CATEGORY_CODE_TAKEN,
          'A support category with this code already exists',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async updateCategory(
    id: string,
    dto: UpdateSupportCategoryDto,
    actor: StaffActor,
  ): Promise<AdminSupportCategoryView> {
    return this.repository.transaction(async (tx) => {
      const before = await this.repository.findCategory(id, tx);
      if (!before) {
        throw new DomainException(
          SupportErrorCode.CATEGORY_NOT_FOUND,
          'Support category not found',
          HttpStatus.NOT_FOUND,
        );
      }
      const updated = await this.repository.updateCategory(
        id,
        { name: dto.name, isEnabled: dto.isEnabled },
        tx,
      );
      await this.audit.record(
        {
          action: 'support_category.update',
          entityType: 'support_category',
          entityId: id,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: {
            from: { name: before.name, isEnabled: before.isEnabled },
            to: { name: updated.name, isEnabled: updated.isEnabled },
          },
        },
        tx,
      );
      return updated;
    });
  }

  // --- the person who raised it ------------------------------------------------------------------------------

  async create(creator: TicketCreator, dto: CreateTicketDto): Promise<TicketDetailView> {
    const category = await this.repository.findCategory(dto.categoryId);
    if (!category || !category.isEnabled) {
      throw new DomainException(
        SupportErrorCode.CATEGORY_INVALID,
        'Choose one of the available support categories',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'categoryId', messages: ['categoryId must be an available category'] }],
      );
    }
    if (dto.bookingId) await this.requireParty(creator, dto.bookingId);
    const ticket = await this.repository.transaction(async (tx) => {
      const created = await this.repository.create(
        {
          creatorUserId: creator.userId,
          creatorKind: creator.kind,
          bookingId: dto.bookingId ?? null,
          categoryId: category.id,
          description: dto.description,
        },
        tx,
      );
      await this.repository.addEvent(
        {
          ticketId: created.id,
          type: 'CREATED',
          fromStatus: null,
          toStatus: 'OPEN',
          actorUserId: creator.userId,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'ticket.create',
          entityType: 'support_ticket',
          entityId: created.id,
          actorId: creator.userId,
          // The description is free text written by the user: it stays out of the audit log.
          metadata: {
            creatorKind: creator.kind,
            categoryCode: category.code,
            bookingId: dto.bookingId ?? null,
          },
        },
        tx,
      );
      return created;
    });
    return this.detail(ticket);
  }

  async listMine(creatorUserId: string, query: MyTicketListQuery): Promise<Page<TicketView>> {
    const { items, total } = await this.repository.list(
      { creatorUserId, status: query.status },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((t) => this.view(t)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** 404 for a ticket that does not exist and for a ticket that belongs to someone else: identical answers. */
  async getMine(creatorUserId: string, ticketId: string): Promise<TicketDetailView> {
    const ticket = await this.repository.findById(ticketId);
    if (!ticket || ticket.creatorUserId !== creatorUserId) throw this.notFound();
    return this.detail(ticket);
  }

  // --- staff -------------------------------------------------------------------------------------------------

  async adminList(query: AdminTicketListQuery): Promise<Page<AdminTicketView>> {
    const { items, total } = await this.repository.list(
      {
        status: query.status,
        priority: query.priority,
        categoryId: query.categoryId,
        assignedToUserId: query.assignedToUserId,
        unassigned: query.unassigned,
        bookingId: query.bookingId,
        creatorKind: query.creatorKind,
      },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((t) => this.adminView(t)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(ticketId: string): Promise<AdminTicketDetailView> {
    const ticket = await this.repository.findById(ticketId);
    if (!ticket) throw this.notFound();
    return this.adminDetail(ticket);
  }

  /** Gives the ticket an owner (the actor by default). The first assignment moves OPEN to IN_PROGRESS. */
  async assign(
    ticketId: string,
    assigneeUserId: string | undefined,
    note: string | undefined,
    actor: StaffActor,
  ): Promise<AdminTicketDetailView> {
    const assignee = assigneeUserId ?? actor.userId;
    await this.requireAssignee(assignee);
    await this.transition(ticketId, async (ticket, tx) => {
      const toStatus = ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status;
      await this.repository.update(
        ticketId,
        { status: toStatus, assignedToUserId: assignee, assignedAt: new Date() },
        tx,
      );
      await this.repository.addEvent(
        {
          ticketId,
          type: 'ASSIGNED',
          fromStatus: ticket.status,
          toStatus,
          actorUserId: actor.userId,
          internalNote: note ?? null,
        },
        tx,
      );
      await this.auditStep('ticket.assign', ticket, actor, tx, {
        from: ticket.status,
        to: toStatus,
        assigneeUserId: assignee,
        previousAssigneeUserId: ticket.assignedToUserId,
      });
      if (toStatus !== ticket.status) await this.notifyCreator(ticket, toStatus, tx);
    });
    return this.adminGet(ticketId);
  }

  async setPriority(
    ticketId: string,
    priority: TicketPriorityValue,
    actor: StaffActor,
  ): Promise<AdminTicketDetailView> {
    await this.transition(ticketId, async (ticket, tx) => {
      if (ticket.priority === priority) return;
      await this.repository.update(ticketId, { priority }, tx);
      await this.repository.addEvent(
        {
          ticketId,
          type: 'PRIORITY_SET',
          fromStatus: ticket.status,
          toStatus: ticket.status,
          actorUserId: actor.userId,
          internalNote: `priority ${ticket.priority ?? 'none'} -> ${priority}`,
        },
        tx,
      );
      await this.auditStep('ticket.priority', ticket, actor, tx, {
        from: ticket.priority,
        to: priority,
      });
    });
    return this.adminGet(ticketId);
  }

  /** OPEN or IN_PROGRESS to ESCALATED (FR-SUP-003). Repeating on an escalated ticket changes nothing. */
  async escalate(
    ticketId: string,
    reason: string,
    actor: StaffActor,
  ): Promise<AdminTicketDetailView> {
    await this.transition(ticketId, async (ticket, tx) => {
      if (ticket.status === 'ESCALATED') return;
      await this.repository.update(ticketId, { status: 'ESCALATED', escalatedAt: new Date() }, tx);
      await this.repository.addEvent(
        {
          ticketId,
          type: 'ESCALATED',
          fromStatus: ticket.status,
          toStatus: 'ESCALATED',
          actorUserId: actor.userId,
          internalNote: reason,
        },
        tx,
      );
      await this.auditStep('ticket.escalate', ticket, actor, tx, {
        from: ticket.status,
        to: 'ESCALATED',
      });
      await this.notifyCreator(ticket, 'ESCALATED', tx);
    });
    return this.adminGet(ticketId);
  }

  /** Closes with the outcome recorded ("Resolution: yes on close"). A closed ticket stays in history and cannot be reopened (Q-59). */
  async close(
    ticketId: string,
    resolution: string,
    actor: StaffActor,
  ): Promise<AdminTicketDetailView> {
    await this.transition(ticketId, async (ticket, tx) => {
      await this.repository.update(
        ticketId,
        { status: 'CLOSED', resolution, closedAt: new Date(), closedByUserId: actor.userId },
        tx,
      );
      await this.repository.addEvent(
        {
          ticketId,
          type: 'CLOSED',
          fromStatus: ticket.status,
          toStatus: 'CLOSED',
          actorUserId: actor.userId,
        },
        tx,
      );
      await this.auditStep('ticket.close', ticket, actor, tx, {
        from: ticket.status,
        to: 'CLOSED',
      });
      await this.notifyCreator(ticket, 'CLOSED', tx);
    });
    return this.adminGet(ticketId);
  }

  // --- internals ---------------------------------------------------------------------------------------------

  /** Locks the ticket, refuses closed ones, runs the change. */
  private async transition(
    ticketId: string,
    work: (ticket: TicketRecord, tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const ticket = await this.repository.lock(ticketId, tx);
      if (!ticket) throw this.notFound();
      if (ticket.status === 'CLOSED') {
        throw new DomainException(
          SupportErrorCode.TICKET_CLOSED,
          'This ticket is closed',
          HttpStatus.CONFLICT,
        );
      }
      await work(ticket, tx);
    });
  }

  private auditStep(
    action: string,
    ticket: TicketRecord,
    actor: StaffActor,
    tx: Prisma.TransactionClient,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        entityType: 'support_ticket',
        entityId: ticket.id,
        actorId: actor.userId,
        actorRole: actor.roles.join(',') || null,
        metadata,
      },
      tx,
    );
  }

  private notifyCreator(
    ticket: TicketRecord,
    status: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    return this.outbox.notify(
      {
        event: NotificationEvent.TICKET_UPDATE,
        recipients: [ticket.creatorUserId],
        params: { ticketId: ticket.id, status },
      },
      tx,
    );
  }

  /** The assignee must be an active admin who can actually work tickets. */
  private async requireAssignee(userId: string): Promise<void> {
    const user = await this.users.getByIdOrThrow(userId).catch(() => null);
    const permissions = user ? (await this.users.getAccess(userId)).permissions : [];
    if (
      !user ||
      user.type !== 'ADMIN' ||
      user.status !== 'ACTIVE' ||
      !permissions.includes(PermissionCode.SUPPORT_MANAGE)
    ) {
      throw new DomainException(
        SupportErrorCode.ASSIGNEE_INVALID,
        'The ticket can only be assigned to an active staff member who can manage tickets',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  /** A ticket may only point at a booking the creator is a party to. Anything else answers like an unknown booking. */
  private async requireParty(creator: TicketCreator, bookingId: string): Promise<void> {
    const booking = await this.bookings.getSummary(bookingId).catch(() => null);
    let isParty = false;
    if (booking) {
      if (creator.kind === 'CUSTOMER') {
        isParty = booking.customerUserId === creator.userId;
      } else {
        const ref = await this.workers.findRefByUserId(creator.userId);
        isParty = !!ref && booking.workerId === ref.workerId;
      }
    }
    if (!isParty) {
      throw new DomainException(
        SupportErrorCode.BOOKING_NOT_FOUND,
        'Booking not found',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async detail(ticket: TicketRecord): Promise<TicketDetailView> {
    const events = await this.repository.events(ticket.id);
    return {
      ...this.view(ticket),
      history: events.map((e) => ({
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        createdAt: e.createdAt,
      })),
    };
  }

  private async adminDetail(ticket: TicketRecord): Promise<AdminTicketDetailView> {
    const events: TicketEventRecord[] = await this.repository.events(ticket.id);
    return {
      ...this.adminView(ticket),
      history: events.map((e) => ({
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        createdAt: e.createdAt,
        actorUserId: e.actorUserId,
        internalNote: e.internalNote,
      })),
    };
  }

  private categoryView(c: CategoryRecord | TicketRecord['category']): SupportCategoryView {
    return { id: c.id, code: c.code, name: c.name };
  }

  private view(t: TicketRecord): TicketView {
    return {
      id: t.id,
      category: this.categoryView(t.category),
      bookingId: t.bookingId,
      description: t.description,
      status: t.status,
      resolution: t.resolution,
      createdAt: t.createdAt,
      closedAt: t.closedAt,
    };
  }

  private adminView(t: TicketRecord): AdminTicketView {
    return {
      id: t.id,
      category: this.categoryView(t.category),
      creatorUserId: t.creatorUserId,
      creatorKind: t.creatorKind,
      bookingId: t.bookingId,
      description: t.description,
      status: t.status,
      priority: t.priority,
      assignedToUserId: t.assignedToUserId,
      assignedAt: t.assignedAt,
      escalatedAt: t.escalatedAt,
      resolution: t.resolution,
      closedAt: t.closedAt,
      closedByUserId: t.closedByUserId,
      createdAt: t.createdAt,
    };
  }

  private notFound(): DomainException {
    return new DomainException(
      SupportErrorCode.TICKET_NOT_FOUND,
      'Ticket not found',
      HttpStatus.NOT_FOUND,
    );
  }
}
