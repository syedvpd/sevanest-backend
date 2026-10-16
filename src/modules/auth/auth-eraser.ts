import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RetentionRegistry,
  type PersonalDataEraser,
} from '../../common/retention/retention.registry';
import type { Prisma } from '../../generated/prisma/client';
import { SessionRepository } from './session.repository';
/** DEC-08: every session of the erased account ends and its push tokens go. */
@Injectable()
export class AuthEraser implements OnModuleInit, PersonalDataEraser {
  readonly name = 'auth';

  constructor(
    private readonly registry: RetentionRegistry,
    private readonly sessions: SessionRepository,
  ) {}

  onModuleInit(): void {
    this.registry.registerEraser(this);
  }

  async erase(userId: string, tx: Prisma.TransactionClient): Promise<{ objectKeys: string[] }> {
    await this.sessions.revokeAllForUser(userId, tx);
    await tx.deviceToken.deleteMany({ where: { userId } });
    return { objectKeys: [] };
  }
}
