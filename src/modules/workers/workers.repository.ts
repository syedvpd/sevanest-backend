import { Injectable } from '@nestjs/common';
import type { Prisma, WorkerOnboardingStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

const PROFILE_SELECT = {
  id: true,
  userId: true,
  name: true,
  onboardingStatus: true,
  submittedAt: true,
  experienceMonths: true,
  expectedSalary: true,
  addressLine: true,
  addressArea: true,
  addressCity: true,
  addressPincode: true,
  emergencyContactName: true,
  emergencyContactMobile: true,
  previousEmployerName: true,
  previousEmployerMobile: true,
  profilePhotoRef: true,
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
  address: { line: string; area: string; city: string; pincode: string } | null;
  emergencyContact: { name: string; mobile: string } | null;
  previousEmployer: { name: string; mobile: string } | null;
  hasProfilePhoto: boolean;
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
}

export type ProfileScalarUpdate = Partial<
  Pick<
    Prisma.WorkerProfileUncheckedUpdateInput,
    | 'name'
    | 'experienceMonths'
    | 'expectedSalary'
    | 'addressLine'
    | 'addressArea'
    | 'addressCity'
    | 'addressPincode'
    | 'emergencyContactName'
    | 'emergencyContactMobile'
    | 'previousEmployerName'
    | 'previousEmployerMobile'
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

  async updateScalars(
    id: string,
    data: ProfileScalarUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (Object.keys(data).length > 0) {
      await tx.workerProfile.update({ where: { id }, data, select: { id: true } });
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
    const where: Prisma.WorkerProfileWhereInput = {
      ...(filter.onboardingStatus ? { onboardingStatus: filter.onboardingStatus } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.categoryId ? { skills: { some: { categoryId: filter.categoryId } } } : {}),
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
