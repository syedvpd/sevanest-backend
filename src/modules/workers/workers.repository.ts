import { Injectable } from '@nestjs/common';
import { Prisma, type WorkerOnboardingStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { verifiedWorkerCondition } from '../verification/verification-eligibility';

type Db = Prisma.TransactionClient | PrismaService;

const PROFILE_SELECT = {
  id: true,
  userId: true,
  name: true,
  onboardingStatus: true,
  submittedAt: true,
  experienceMonths: true,
  expectedSalary: true,
  preferredLanguage: true,
  addressLine: true,
  addressArea: true,
  addressCity: true,
  addressPincode: true,
  emergencyContactName: true,
  emergencyContactMobile: true,
  previousEmployerName: true,
  previousEmployerMobile: true,
  profilePhotoRef: true,
  criminalRecordDeclared: true,
  criminalRecordDetails: true,
  criminalDeclaredAt: true,
  blacklistedAt: true,
  blacklistReason: true,
  blacklistedByUserId: true,
  createdAt: true,
  updatedAt: true,
  languages: { select: { languageCode: true }, orderBy: { languageCode: 'asc' } },
  skills: { select: { categoryId: true } },
} satisfies Prisma.WorkerProfileSelect;

type ProfileRow = Prisma.WorkerProfileGetPayload<{ select: typeof PROFILE_SELECT }>;

export interface WorkerRecord {
  id: string;
  userId: string;
  name: string;
  onboardingStatus: WorkerOnboardingStatus;
  submittedAt: Date | null;
  experienceMonths: number | null;
  expectedSalary: number | null;
  preferredLanguage: string | null;
  address: { line: string; area: string; city: string; pincode: string } | null;
  emergencyContact: { name: string; mobile: string } | null;
  previousEmployer: { name: string; mobile: string } | null;
  hasProfilePhoto: boolean;
  criminalDeclaration: {
    hasCriminalRecord: boolean;
    details: string | null;
    acceptedAt: Date;
  } | null;
  /** DEC-06: set while blacklisted. */
  blacklist: { at: Date; reason: string; byUserId: string | null } | null;
  languages: string[];
  categoryIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: ProfileRow): WorkerRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    onboardingStatus: row.onboardingStatus,
    submittedAt: row.submittedAt,
    experienceMonths: row.experienceMonths,
    expectedSalary: row.expectedSalary === null ? null : Number(row.expectedSalary),
    preferredLanguage: row.preferredLanguage,
    address:
      row.addressLine === null
        ? null
        : {
            line: row.addressLine,
            area: row.addressArea!,
            city: row.addressCity!,
            pincode: row.addressPincode!,
          },
    emergencyContact:
      row.emergencyContactName === null
        ? null
        : { name: row.emergencyContactName, mobile: row.emergencyContactMobile! },
    previousEmployer:
      row.previousEmployerName === null
        ? null
        : { name: row.previousEmployerName, mobile: row.previousEmployerMobile! },
    hasProfilePhoto: row.profilePhotoRef !== null,
    criminalDeclaration:
      row.criminalRecordDeclared === null
        ? null
        : {
            hasCriminalRecord: row.criminalRecordDeclared,
            details: row.criminalRecordDetails,
            acceptedAt: row.criminalDeclaredAt!,
          },
    blacklist:
      row.blacklistedAt === null
        ? null
        : {
            at: row.blacklistedAt,
            reason: row.blacklistReason ?? '',
            byUserId: row.blacklistedByUserId,
          },
    languages: row.languages.map((l) => l.languageCode),
    categoryIds: row.skills.map((s) => s.categoryId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface WorkerListFilter {
  onboardingStatus?: WorkerOnboardingStatus;
  categoryId?: string;
  userId?: string;
  name?: string;
  accountStatus?: 'ACTIVE' | 'SUSPENDED';
  createdFrom?: Date;
  createdTo?: Date;
  areaId?: string;
  minRating?: number;
  verified?: boolean;
}

export type ProfileScalarUpdate = Partial<
  Pick<
    Prisma.WorkerProfileUncheckedUpdateInput,
    | 'name'
    | 'experienceMonths'
    | 'expectedSalary'
    | 'preferredLanguage'
    | 'addressLine'
    | 'addressArea'
    | 'addressCity'
    | 'addressPincode'
    | 'addressLatitude'
    | 'addressLongitude'
    | 'emergencyContactName'
    | 'emergencyContactMobile'
    | 'previousEmployerName'
    | 'previousEmployerMobile'
    | 'criminalRecordDeclared'
    | 'criminalRecordDetails'
    | 'criminalDeclaredAt'
  >
>;

/** The only place that reads or writes `worker_profiles`, `worker_skills` and `worker_languages`. */
@Injectable()
export class WorkersRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async findByUserId(userId: string, db: Db = this.prisma): Promise<WorkerRecord | null> {
    const row = await db.workerProfile.findUnique({ where: { userId }, select: PROFILE_SELECT });
    return row ? toRecord(row) : null;
  }

  /** Names of several workers in one statement (for cards that show who served the customer). */
  async namesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.workerProfile.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async findById(id: string, db: Db = this.prisma): Promise<WorkerRecord | null> {
    const row = await db.workerProfile.findUnique({ where: { id }, select: PROFILE_SELECT });
    return row ? toRecord(row) : null;
  }

  async create(
    data: { userId: string; name: string },
    tx: Prisma.TransactionClient,
  ): Promise<WorkerRecord> {
    return toRecord(await tx.workerProfile.create({ data, select: PROFILE_SELECT }));
  }

  /** Serialises every mutation of one worker's profile for the rest of the transaction. */
  async lock(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM worker_profiles WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1;
  }

  /** Sets (or, with null, clears) the blacklist columns. Call under lock(). */
  async setBlacklist(
    id: string,
    value: { reason: string; byUserId: string } | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workerProfile.update({
      where: { id },
      data: value
        ? {
            blacklistedAt: new Date(),
            blacklistReason: value.reason,
            blacklistedByUserId: value.byUserId,
          }
        : { blacklistedAt: null, blacklistReason: null, blacklistedByUserId: null },
      select: { id: true },
    });
  }

  async updateScalars(
    id: string,
    data: ProfileScalarUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (Object.keys(data).length > 0) {
      await tx.workerProfile.update({ where: { id }, data, select: { id: true } });
    }
  }

  async listReferences(
    workerId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Array<{ id: string; name: string; mobile: string; relationship: string | null }>> {
    return db.workerReference.findMany({
      where: { workerId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, mobile: true, relationship: true },
    });
  }

  async replaceReferences(
    workerId: string,
    references: Array<{ name: string; mobile: string; relationship?: string }>,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workerReference.deleteMany({ where: { workerId } });
    if (references.length > 0) {
      await tx.workerReference.createMany({
        data: references.map((r, position) => ({
          workerId,
          position,
          name: r.name,
          mobile: r.mobile,
          relationship: r.relationship ?? null,
        })),
      });
    }
  }

  async replaceLanguages(
    workerId: string,
    codes: string[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workerLanguage.deleteMany({ where: { workerId } });
    await tx.workerLanguage.createMany({
      data: codes.map((languageCode) => ({ workerId, languageCode })),
    });
  }

  async addSkills(
    workerId: string,
    categoryIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (categoryIds.length > 0) {
      await tx.workerSkill.createMany({
        data: categoryIds.map((categoryId) => ({ workerId, categoryId })),
        skipDuplicates: true,
      });
    }
  }

  async removeSkills(
    workerId: string,
    categoryIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (categoryIds.length > 0) {
      await tx.workerSkill.deleteMany({ where: { workerId, categoryId: { in: categoryIds } } });
    }
  }

  async setPhotoRef(id: string, ref: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.workerProfile.update({ where: { id }, data: { profilePhotoRef: ref } });
  }

  async markSubmitted(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.workerProfile.update({
      where: { id },
      data: { onboardingStatus: 'SUBMITTED', submittedAt: at },
      select: { id: true },
    });
  }

  async list(
    filter: WorkerListFilter,
    skip: number,
    take: number,
  ): Promise<{ items: WorkerRecord[]; total: number }> {
    let ratedIds: string[] | undefined;
    if (filter.minRating !== undefined) {
      const rated = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT worker_id AS id FROM worker_rating_summaries
        WHERE rating_count > 0 AND rating_sum::float8 / rating_count >= ${filter.minRating}`);
      ratedIds = rated.map((r) => r.id);
    }
    let verifiedIds: string[] | undefined;
    if (filter.verified !== undefined) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT wp.id FROM worker_profiles wp WHERE ${verifiedWorkerCondition('wp.id')}`);
      verifiedIds = rows.map((r) => r.id);
    }
    const where: Prisma.WorkerProfileWhereInput = {
      ...(ratedIds ? { id: { in: ratedIds } } : {}),
      ...(verifiedIds
        ? { AND: [{ id: filter.verified ? { in: verifiedIds } : { notIn: verifiedIds } }] }
        : {}),
      ...(filter.areaId ? { preferredAreas: { some: { areaId: filter.areaId } } } : {}),
      ...(filter.onboardingStatus ? { onboardingStatus: filter.onboardingStatus } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.categoryId ? { skills: { some: { categoryId: filter.categoryId } } } : {}),
      ...(filter.name ? { name: { contains: filter.name, mode: 'insensitive' as const } } : {}),
      ...(filter.accountStatus ? { user: { is: { status: filter.accountStatus } } } : {}),
      ...(filter.createdFrom || filter.createdTo
        ? {
            createdAt: {
              ...(filter.createdFrom ? { gte: filter.createdFrom } : {}),
              ...(filter.createdTo ? { lte: filter.createdTo } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workerProfile.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: PROFILE_SELECT,
      }),
      this.prisma.workerProfile.count({ where }),
    ]);
    return { items: rows.map(toRecord), total };
  }
}
