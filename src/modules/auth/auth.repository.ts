import { Injectable } from '@nestjs/common';
import type { UserStatus, UserType } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface ActiveSession {
  sessionId: string;
  userId: string;
  userType: UserType;
  userStatus: UserStatus;
}

export interface RoleAndPermissionCodes {
  roles: string[];
  permissions: string[];
}

/** The only place in the auth foundation that talks to Prisma. */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Session must exist, not be revoked and not be expired. Returns the owning user's type and status in one query. */
  async findActiveSession(sessionId: string, now: Date): Promise<ActiveSession | null> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, user: { select: { id: true, type: true, status: true } } },
    });
    if (!session) {
      return null;
    }
    return {
      sessionId: session.id,
      userId: session.user.id,
      userType: session.user.type,
      userStatus: session.user.status,
    };
  }

  /** Role codes and the union of their permission codes, in a fixed number of queries (no N+1). */
  async getRoleAndPermissionCodes(userId: string): Promise<RoleAndPermissionCodes> {
    const assignments = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: {
            code: true,
            permissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });
    const roles = new Set<string>();
    const permissions = new Set<string>();
    for (const { role } of assignments) {
      roles.add(role.code);
      for (const { permission } of role.permissions) {
        permissions.add(permission.code);
      }
    }
    return { roles: [...roles], permissions: [...permissions] };
  }
}
