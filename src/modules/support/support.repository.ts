import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { TicketPriorityValue, TicketStatusValue } from './dto/support.dto';

type Db = Prisma.TransactionClient | PrismaService;

const WITH_CATEGORY = { category: { select: { id: true, code: true, name: true } } } as const;

export interface TicketRecord {
  id: string;
  creatorUserId: string;
  creatorKind: 'CUSTOMER' | 'WORKER' | 'ADMIN';
  bookingId: string | null;
  categoryId: string;
  description: string;
  priority: TicketPriorityValue | null;
  status: TicketStatusValue;
  assignedToUserId: string | null;
  assignedAt: Date | null;
  escalatedAt: Date | null;
  resolution: string | null;
  closedAt: Date | null;
  closedByUserId: string | null;
  createdAt: Date;
  category: { id: string; code: string; name: string };
}

export interface TicketEventRecord {
  type: string;
  fromStatus: TicketStatusValue | null;
  toStatus: TicketStatusValue | null;
  actorUserId: string;
  internalNote: string | null;
  createdAt: Date;
}

export interface CategoryRecord {
  id: string;
  code: string;
  name: string;
  isEnabled: boolean;
}

export interface TicketFilter {
  creatorUserId?: string;
  status?: TicketStatusValue;
  priority?: TicketPriorityValue;
  categoryId?: string;
  assignedToUserId?: string;
  unassigned?: boolean;
  bookingId?: string;
  creatorKind?: 'CUSTOMER' | 'WORKER';
}

export interface TicketChange {
  status?: TicketStatusValue;
  priority?: TicketPriorityValue;
  assignedToUserId?: string;
  assignedAt?: Date;
  escalatedAt?: Date;
  resolution?: string;
  closedAt?: Date;
  closedByUserId?: string;
}

/** The only place that touches `support_tickets`, `support_ticket_events` and `support_categories`. */
@Injectable()
export class SupportRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // --- tickets ---------------------------------------------------------------------------------------------------

  async create(
    input: {
      creatorUserId: string;
      creatorKind: 'CUSTOMER' | 'WORKER';
      bookingId: string | null;
      categoryId: string;
      description: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<TicketRecord> {
    return tx.supportTicket.create({ data: input, include: WITH_CATEGORY });
  }

  findById(id: string, db: Db = this.prisma): Promise<TicketRecord | null> {
    return db.supportTicket.findUnique({ where: { id }, include: WITH_CATEGORY });
  }

  async lock(id: string, tx: Prisma.TransactionClient): Promise<TicketRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM support_tickets WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1 ? this.findById(id, tx) : null;
  }

  async update(id: string, change: TicketChange, tx: Prisma.TransactionClient): Promise<void> {
    await tx.supportTicket.update({ where: { id }, data: change });
  }

  async list(
    filter: TicketFilter,
    skip: number,
    take: number,
  ): Promise<{ items: TicketRecord[]; total: number }> {
    const where: Prisma.SupportTicketWhereInput = {
      ...(filter.creatorUserId ? { creatorUserId: filter.creatorUserId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.priority ? { priority: filter.priority } : {}),
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
      ...(filter.creatorKind ? { creatorKind: filter.creatorKind } : {}),
      ...(filter.unassigned
        ? { assignedToUserId: null }
        : filter.assignedToUserId
          ? { assignedToUserId: filter.assignedToUserId }
          : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        include: WITH_CATEGORY,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return { items, total };
  }

  // --- history ---------------------------------------------------------------------------------------------------

  async addEvent(
    input: {
      ticketId: string;
      type: string;
      fromStatus: TicketStatusValue | null;
      toStatus: TicketStatusValue | null;
      actorUserId: string;
      internalNote?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.supportTicketEvent.create({
      data: { ...input, internalNote: input.internalNote ?? null },
    });
  }

  events(ticketId: string): Promise<TicketEventRecord[]> {
    return this.prisma.supportTicketEvent.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        type: true,
        fromStatus: true,
        toStatus: true,
        actorUserId: true,
        internalNote: true,
        createdAt: true,
      },
    });
  }

  // --- categories ------------------------------------------------------------------------------------------------

  listCategories(enabledOnly: boolean): Promise<CategoryRecord[]> {
    return this.prisma.supportCategory.findMany({
      where: enabledOnly ? { isEnabled: true } : {},
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, code: true, name: true, isEnabled: true },
    });
  }

  findCategory(id: string, db: Db = this.prisma): Promise<CategoryRecord | null> {
    return db.supportCategory.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, isEnabled: true },
    });
  }

  createCategory(
    input: { code: string; name: string },
    tx: Prisma.TransactionClient,
  ): Promise<CategoryRecord> {
    return tx.supportCategory.create({
      data: input,
      select: { id: true, code: true, name: true, isEnabled: true },
    });
  }

  updateCategory(
    id: string,
    change: { name?: string; isEnabled?: boolean },
    tx: Prisma.TransactionClient,
  ): Promise<CategoryRecord> {
    return tx.supportCategory.update({
      where: { id },
      data: change,
      select: { id: true, code: true, name: true, isEnabled: true },
    });
  }
}
