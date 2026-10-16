import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type PersonalDataEraser,
} from '../../common/retention/retention.registry';
import type { Prisma } from '../../generated/prisma/client';

/** DEC-08: the customer's photos and renditions are removed (rows now, stored files after the commit). */
@Injectable()
export class CustomerPhotoEraser implements OnModuleInit, PersonalDataEraser {
  readonly name = 'customer-photo';

  constructor(private readonly registry: RetentionRegistry) {}

  onModuleInit(): void {
    this.registry.registerEraser(this);
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    const photos = await tx.customerProfilePhoto.findMany({ where: { customerUserId: userId } });
    await tx.customerProfilePhoto.deleteMany({ where: { customerUserId: userId } });
    return {
      objectKeys: photos.flatMap((p) =>
        [p.objectKey, p.cardObjectKey, p.largeObjectKey].filter((k): k is string => !!k),
      ),
    };
  }
}
