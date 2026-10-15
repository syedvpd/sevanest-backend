import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface CustomerPhotoRecord {
  id: string;
  customerUserId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  status: 'PENDING_UPLOAD' | 'READY';
  cardObjectKey: string | null;
  largeObjectKey: string | null;
}

const SELECT = {
  id: true,
  customerUserId: true,
  objectKey: true,
  contentType: true,
  sizeBytes: true,
  status: true,
  cardObjectKey: true,
  largeObjectKey: true,
} as const;

/** The only place that touches `customer_profile_photos`. */
@Injectable()
export class CustomerPhotoRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  create(
    data: { customerUserId: string; objectKey: string; contentType: string; sizeBytes: number },
    tx: Prisma.TransactionClient,
  ): Promise<CustomerPhotoRecord> {
    return tx.customerProfilePhoto.create({ data, select: SELECT });
  }

  /** Serialises uploads and confirmations of one customer's photos. */
  async lockCustomer(customerUserId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-photo:${customerUserId}`}, 0))`;
  }

  countPending(customerUserId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.customerProfilePhoto.count({ where: { customerUserId, status: 'PENDING_UPLOAD' } });
  }

  find(id: string, tx?: Prisma.TransactionClient): Promise<CustomerPhotoRecord | null> {
    return (tx ?? this.prisma).customerProfilePhoto.findUnique({ where: { id }, select: SELECT });
  }

  async markReady(
    id: string,
    renditions: { card: string; large: string },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.customerProfilePhoto.update({
      where: { id },
      data: {
        status: 'READY',
        confirmedAt: new Date(),
        cardObjectKey: renditions.card,
        largeObjectKey: renditions.large,
      },
    });
  }

  /** Removes the customer's earlier READY photos (rows) and returns them so their objects can be deleted. */
  async removeSuperseded(
    customerUserId: string,
    keepId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CustomerPhotoRecord[]> {
    const old = await tx.customerProfilePhoto.findMany({
      where: { customerUserId, status: 'READY', id: { not: keepId } },
      select: SELECT,
    });
    if (old.length > 0) {
      await tx.customerProfilePhoto.deleteMany({ where: { id: { in: old.map((p) => p.id) } } });
    }
    return old;
  }

  /** The newest READY photo of the customer. */
  current(customerUserId: string): Promise<CustomerPhotoRecord | null> {
    return this.prisma.customerProfilePhoto.findFirst({
      where: { customerUserId, status: 'READY' },
      orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
      select: SELECT,
    });
  }

  findAbandoned(before: Date, limit: number): Promise<CustomerPhotoRecord[]> {
    return this.prisma.customerProfilePhoto.findMany({
      where: { status: 'PENDING_UPLOAD', createdAt: { lt: before } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: SELECT,
    });
  }

  async deletePending(id: string): Promise<boolean> {
    const result = await this.prisma.customerProfilePhoto.deleteMany({
      where: { id, status: 'PENDING_UPLOAD' },
    });
    return result.count === 1;
  }
}
