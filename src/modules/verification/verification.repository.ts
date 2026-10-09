import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { CheckType, StoredCheckStatus } from './dto/verification.dto';
import { verifiedWorkerCondition } from './verification-eligibility';

type Db = Prisma.TransactionClient | PrismaService;

export interface CheckRecord {
  id: string;
  workerId: string;
  checkType: CheckType;
  status: StoredCheckStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewerUserId: string | null;
  remarks: string | null;
  /** YYYY-MM-DD (India date) or null. */
  recheckAt: string | null;
}

export interface DocumentRecord {
  id: string;
  checkId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  status: 'PENDING_UPLOAD' | 'UPLOADED';
  uploadedAt: Date | null;
  submittedAt: Date | null;
  createdAt: Date;
}

export interface EventRecord {
  checkId: string;
  fromStatus: StoredCheckStatus | null;
  toStatus: StoredCheckStatus;
  actorUserId: string;
  remarks: string | null;
  createdAt: Date;
}

type CheckRow = Prisma.WorkerVerificationCheckGetPayload<object>;

function toCheck(row: CheckRow): CheckRecord {
  return {
    id: row.id,
    workerId: row.workerId,
    checkType: row.checkType,
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewerUserId: row.reviewerUserId,
    remarks: row.remarks,
    recheckAt: row.recheckAt ? row.recheckAt.toISOString().slice(0, 10) : null,
  };
}

export interface CheckUpdate {
  status: StoredCheckStatus;
  submittedAt?: Date | null;
  reviewedAt?: Date | null;
  reviewerUserId?: string | null;
  remarks?: string | null;
  recheckAt?: string | null;
}

/** The only place in the application that touches the verification tables (Prisma models). */
@Injectable()
export class VerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // --- requirements -----------------------------------------------------------------------------------------

  async getRequirements(db: Db = this.prisma): Promise<CheckType[]> {
    const rows = await db.verificationRequirement.findMany({ orderBy: { checkType: 'asc' } });
    return rows.map((r) => r.checkType);
  }

  async replaceRequirements(types: CheckType[], tx: Prisma.TransactionClient): Promise<void> {
    await tx.verificationRequirement.deleteMany({});
    if (types.length > 0) {
      await tx.verificationRequirement.createMany({
        data: types.map((checkType) => ({ checkType })),
      });
    }
  }

  /** Serialises requirement changes (two admins replacing the set at once). */
  async lockRequirements(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('verification_requirements', 0))`;
  }

  // --- checks -----------------------------------------------------------------------------------------------

  async listChecks(workerId: string, db: Db = this.prisma): Promise<CheckRecord[]> {
    const rows = await db.workerVerificationCheck.findMany({
      where: { workerId },
      orderBy: { checkType: 'asc' },
    });
    return rows.map(toCheck);
  }

  async ensureCheck(
    workerId: string,
    checkType: CheckType,
    tx: Prisma.TransactionClient,
  ): Promise<CheckRecord> {
    const row = await tx.workerVerificationCheck.upsert({
      where: { workerId_checkType: { workerId, checkType } },
      create: { workerId, checkType },
      update: {},
    });
    return toCheck(row);
  }

  async findCheckById(id: string, db: Db = this.prisma): Promise<CheckRecord | null> {
    const row = await db.workerVerificationCheck.findUnique({ where: { id } });
    return row ? toCheck(row) : null;
  }

  /** Locks one check row for the rest of the transaction; every status change goes through it. */
  async lockCheck(id: string, tx: Prisma.TransactionClient): Promise<CheckRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM worker_verification_checks WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1 ? this.findCheckById(id, tx) : null;
  }

  async updateCheck(id: string, data: CheckUpdate, tx: Prisma.TransactionClient): Promise<void> {
    await tx.workerVerificationCheck.update({
      where: { id },
      data: {
        status: data.status,
        submittedAt: data.submittedAt,
        reviewedAt: data.reviewedAt,
        reviewerUserId: data.reviewerUserId,
        remarks: data.remarks,
        recheckAt:
          data.recheckAt === undefined
            ? undefined
            : data.recheckAt === null
              ? null
              : new Date(`${data.recheckAt}T00:00:00.000Z`),
      },
    });
  }

  async addEvent(
    input: {
      checkId: string;
      fromStatus: StoredCheckStatus | null;
      toStatus: StoredCheckStatus;
      actorUserId: string;
      remarks?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workerVerificationEvent.create({
      data: {
        checkId: input.checkId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        actorUserId: input.actorUserId,
        remarks: input.remarks ?? null,
      },
    });
  }

  async listEvents(checkIds: string[], db: Db = this.prisma): Promise<EventRecord[]> {
    if (checkIds.length === 0) return [];
    const rows = await db.workerVerificationEvent.findMany({
      where: { checkId: { in: checkIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      checkId: r.checkId,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      actorUserId: r.actorUserId,
      remarks: r.remarks,
      createdAt: r.createdAt,
    }));
  }

  async queue(
    filter: { statuses: StoredCheckStatus[]; checkType?: CheckType },
    skip: number,
    take: number,
  ): Promise<{ items: CheckRecord[]; total: number; uploadedByCheck: Map<string, number> }> {
    const where: Prisma.WorkerVerificationCheckWhereInput = {
      status: { in: filter.statuses },
      ...(filter.checkType ? { checkType: filter.checkType } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workerVerificationCheck.findMany({
        where,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.workerVerificationCheck.count({ where }),
    ]);
    const counts = rows.length
      ? await this.prisma.verificationDocument.groupBy({
          by: ['checkId'],
          where: { checkId: { in: rows.map((r) => r.id) }, status: 'UPLOADED' },
          _count: { _all: true },
        })
      : [];
    return {
      items: rows.map(toCheck),
      total,
      uploadedByCheck: new Map(counts.map((c) => [c.checkId, c._count._all])),
    };
  }

  // --- documents --------------------------------------------------------------------------------------------

  createDocument(
    input: { checkId: string; objectKey: string; contentType: string; sizeBytes: number },
    tx: Prisma.TransactionClient,
  ): Promise<DocumentRecord> {
    return tx.verificationDocument.create({ data: input });
  }

  findDocument(id: string, db: Db = this.prisma): Promise<DocumentRecord | null> {
    return db.verificationDocument.findUnique({ where: { id } });
  }

  listDocuments(checkIds: string[], db: Db = this.prisma): Promise<DocumentRecord[]> {
    return checkIds.length === 0
      ? Promise.resolve([])
      : db.verificationDocument.findMany({
          where: { checkId: { in: checkIds } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
  }

  /** Open draft documents of a check (not yet part of any submission). */
  countOpenDocuments(checkId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.verificationDocument.count({ where: { checkId, submittedAt: null } });
  }

  countUploadedOpenDocuments(checkId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.verificationDocument.count({
      where: { checkId, submittedAt: null, status: 'UPLOADED' },
    });
  }

  async markUploaded(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.verificationDocument.update({
      where: { id },
      data: { status: 'UPLOADED', uploadedAt: at },
    });
  }

  async stampSubmitted(checkId: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.verificationDocument.updateMany({
      where: { checkId, submittedAt: null, status: 'UPLOADED' },
      data: { submittedAt: at },
    });
  }

  // --- eligibility ------------------------------------------------------------------------------------------

  async isVerified(workerId: string, db: Db = this.prisma): Promise<boolean> {
    const rows = await db.$queryRaw<Array<{ ok: boolean }>>(
      Prisma.sql`SELECT ${verifiedWorkerCondition('wp.id')} AS ok FROM worker_profiles wp WHERE wp.id = ${workerId}::uuid`,
    );
    return rows[0]?.ok === true;
  }
}
