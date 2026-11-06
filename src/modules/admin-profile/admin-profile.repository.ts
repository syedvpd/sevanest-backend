import { Injectable } from '@nestjs/common';
import type { AdminProfile, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** The only place that reads or writes `admin_profiles`. */
@Injectable()
export class AdminProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  find(userId: string, db: Db = this.prisma): Promise<AdminProfile | null> {
    return db.adminProfile.findUnique({ where: { userId } });
  }

  /** Creates the row on first write; never touches existing values. */
  ensure(userId: string, db: Db = this.prisma): Promise<AdminProfile> {
    return db.adminProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  update(
    userId: string,
    data: Prisma.AdminProfileUpdateInput,
    db: Db = this.prisma,
  ): Promise<AdminProfile> {
    return db.adminProfile.update({ where: { userId }, data });
  }

  /** Serialises concurrent self-service writes for the same account (name, e-mail, phone, photo). */
  async lockUser(userId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  }
}
