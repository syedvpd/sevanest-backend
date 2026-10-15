import { Injectable } from '@nestjs/common';
import { Prisma, type UserStatus, type UserType } from '../../generated/prisma/client';
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
    // One round trip (Prisma's relation select would issue two sequential statements on every authenticated request).
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; user_id: string; type: UserType; status: UserStatus }>
    >(Prisma.sql`
      SELECT s.id, u.id AS user_id, u.type::text AS type, u.status::text AS status
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${sessionId}::uuid AND s.revoked_at IS NULL AND s.expires_at > ${now}
      LIMIT 1`);
    const row = rows[0];
    return row
      ? { sessionId: row.id, userId: row.user_id, userType: row.type, userStatus: row.status }
      : null;
  }

  /** Current status of an account (null = no such user). Used only on the failure path of authentication. */
  async userStatus(userId: string): Promise<'ACTIVE' | 'SUSPENDED' | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    return user ? user.status : null;
  }

  /** Role codes and the union of their permission codes, in a fixed number of queries (no N+1). */
  async getRoleAndPermissionCodes(userId: string): Promise<RoleAndPermissionCodes> {
    // One statement instead of four sequential ones (user_roles, roles, role_permissions, permissions).
    const rows = await this.prisma.$queryRaw<Array<{ role: string; permission: string | null }>>(
      Prisma.sql`
        SELECT r.code AS role, p.code AS permission
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = ${userId}::uuid`,
    );
    const roles = new Set<string>();
    const permissions = new Set<string>();
    for (const row of rows) {
      roles.add(row.role);
      if (row.permission) permissions.add(row.permission);
    }
    return { roles: [...roles], permissions: [...permissions] };
  }
}
