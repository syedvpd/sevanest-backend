import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type PersonalDataEraser,
} from '../../common/retention/retention.registry';
import type { Prisma } from '../../generated/prisma/client';

/** DEC-08: the worker's photos and their renditions are removed (rows now, stored files after the commit). */
@Injectable()
export class WorkerPhotoEraser implements OnModuleInit, PersonalDataEraser {
  readonly name = 'worker-photo';

  constructor(private readonly registry: RetentionRegistry) {}

  onModuleInit(): void {
    this.registry.registerEraser(this);
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    const profile = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM worker_profiles WHERE user_id = ${userId}::uuid`;
    if (profile.length === 0) return { objectKeys: [] };
    const photos = await tx.workerProfilePhoto.findMany({ where: { workerId: profile[0].id } });
    await tx.workerProfilePhoto.deleteMany({ where: { workerId: profile[0].id } });
    return {
      objectKeys: photos.flatMap((p) =>
        [p.objectKey, p.cardObjectKey, p.largeObjectKey].filter((k): k is string => !!k),
      ),
    };
  }
}
