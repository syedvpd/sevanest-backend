import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type PersonalDataEraser,
} from '../../common/retention/retention.registry';
import type { Prisma } from '../../generated/prisma/client';

/** DEC-08: the account row loses its identifiers and is closed; the id stays so bookings, payments and audit rows still point at it. */
@Injectable()
export class UserEraser implements OnModuleInit, PersonalDataEraser {
  readonly name = 'users';

  constructor(private readonly registry: RetentionRegistry) {}

  onModuleInit(): void {
    this.registry.registerEraser(this);
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    await tx.user.update({
      where: { id: userId },
      data: {
        mobile: null,
        email: `deleted-${userId}@deleted.invalid`,
        passwordHash: null,
        status: 'SUSPENDED',
      },
    });
    return { objectKeys: [] };
  }
}
