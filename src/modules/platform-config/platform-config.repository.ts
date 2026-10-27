import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export interface SettingRecord {
  key: string;
  value: string;
  updatedAt: Date;
}

export interface RatingTagRecord {
  code: string;
  label: string;
  sentiment: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Owns `app_settings` and `rating_tags`. */
@Injectable()
export class PlatformConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  listSettings(db: Db = this.prisma): Promise<SettingRecord[]> {
    return db.appSetting.findMany({ select: { key: true, value: true, updatedAt: true } });
  }

  upsertSetting(
    key: string,
    value: string,
    byUserId: string,
    db: Db = this.prisma,
  ): Promise<unknown> {
    return db.appSetting.upsert({
      where: { key },
      create: { key, value, updatedByUserId: byUserId },
      update: { value, updatedByUserId: byUserId },
    });
  }

  async deleteSetting(key: string, db: Db = this.prisma): Promise<boolean> {
    return (await db.appSetting.deleteMany({ where: { key } })).count > 0;
  }

  listTags(onlyActive: boolean, db: Db = this.prisma): Promise<RatingTagRecord[]> {
    return db.ratingTag.findMany({
      where: onlyActive ? { isActive: true } : {},
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  findTag(code: string, db: Db = this.prisma): Promise<RatingTagRecord | null> {
    return db.ratingTag.findUnique({ where: { code } });
  }

  createTag(
    data: { code: string; label: string; sentiment: string; sortOrder: number },
    db: Db = this.prisma,
  ): Promise<RatingTagRecord> {
    return db.ratingTag.create({ data });
  }

  updateTag(
    code: string,
    data: { label?: string; sentiment?: string; sortOrder?: number; isActive?: boolean },
    db: Db = this.prisma,
  ): Promise<RatingTagRecord> {
    return db.ratingTag.update({ where: { code }, data });
  }
}
