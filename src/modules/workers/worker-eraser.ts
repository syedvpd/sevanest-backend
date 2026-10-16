import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type PersonalDataEraser,
} from '../../common/retention/retention.registry';
import type { Prisma } from '../../generated/prisma/client';

/**
 * DEC-08: the worker's personal profile data is removed: name, address, emergency contact, previous employer, references, criminal
 * self-declaration, photo reference, salary expectation. Skills, languages and availability stay (they identify nobody); bookings keep
 * pointing at the profile id.
 */
@Injectable()
export class WorkerEraser implements OnModuleInit, PersonalDataEraser {
  readonly name = 'workers';

  constructor(private readonly registry: RetentionRegistry) {}

  onModuleInit(): void {
    this.registry.registerEraser(this);
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    const profile = await tx.workerProfile.findUnique({ where: { userId } });
    if (!profile) return { objectKeys: [] };
    await tx.workerReference.deleteMany({ where: { workerId: profile.id } });
    await tx.workerProfile.update({
      where: { id: profile.id },
      data: {
        name: 'Deleted worker',
        addressLine: null,
        addressArea: null,
        addressCity: null,
        addressPincode: null,
        emergencyContactName: null,
        emergencyContactMobile: null,
        previousEmployerName: null,
        previousEmployerMobile: null,
        profilePhotoRef: null,
        criminalRecordDeclared: null,
        criminalRecordDetails: null,
        criminalDeclaredAt: null,
        expectedSalary: null,
      },
    });
    return { objectKeys: [] };
  }
}
