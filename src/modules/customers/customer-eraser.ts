import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type PersonalDataEraser,
} from '../../common/retention/retention.registry';
import type { Prisma } from '../../generated/prisma/client';

/** DEC-08: name, e-mail and every saved address are replaced by placeholders. Address rows stay (old bookings reference them). */
@Injectable()
export class CustomerEraser implements OnModuleInit, PersonalDataEraser {
  readonly name = 'customers';

  constructor(private readonly registry: RetentionRegistry) {}

  onModuleInit(): void {
    this.registry.registerEraser(this);
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    const profile = await tx.customerProfile.findUnique({ where: { userId } });
    if (!profile) return { objectKeys: [] };
    await tx.customerAddress.updateMany({
      where: { customerId: profile.id },
      data: {
        line: 'Deleted',
        area: 'Deleted',
        city: 'Deleted',
        pincode: '000000',
        label: null,
        line2: null,
        state: null,
        latitude: null,
        longitude: null,
        isDefault: false,
        isActive: false,
      },
    });
    await tx.customerNote.deleteMany({ where: { customerId: profile.id } });
    await tx.customerProfile.update({
      where: { id: profile.id },
      data: { name: 'Deleted user', email: `deleted-${profile.id}@deleted.invalid` },
    });
    return { objectKeys: [] };
  }
}
