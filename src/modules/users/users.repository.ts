import { Injectable } from '@nestjs/common';
import type { Prisma, UserStatus, UserType } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { RoleAndPermissions, UserCredentialRecord, UserRecord } from './users.types';

type Db = Prisma.TransactionClient | PrismaService;

const PUBLIC_SELECT = {
  id: true,
  type: true,
  status: true,
  mobile: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

/** The only place that reads or writes `users`, `roles`, `permissions`, `user_roles`, `role_permissions`. */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Runs `work` in one database transaction. Business operations spanning several writes use this. */
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  findById(id: string, db: Db = this.prisma): Promise<UserRecord | null> {
    return db.user.findUnique({ where: { id }, select: PUBLIC_SELECT });
  }

  findManyByIds(ids: string[]): Promise<UserRecord[]> {
    return this.prisma.user.findMany({ where: { id: { in: ids } }, select: PUBLIC_SELECT });
  }

  findByMobile(mobile: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { mobile }, select: PUBLIC_SELECT });
  }

  findCredentialsByEmail(email: string): Promise<UserCredentialRecord | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { ...PUBLIC_SELECT, passwordHash: true },
    });
  }

  create(
    data: { type: UserType; mobile?: string; email?: string; passwordHash?: string },
    db: Db = this.prisma,
  ): Promise<UserRecord> {
    return db.user.create({ data, select: PUBLIC_SELECT });
  }

  /** Locks the row for the rest of the transaction so concurrent status changes serialise. */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<UserRecord | null> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    return this.findById(id, tx);
  }

  updateStatus(id: string, status: UserStatus, tx: Prisma.TransactionClient): Promise<UserRecord> {
    return tx.user.update({ where: { id }, data: { status }, select: PUBLIC_SELECT });
  }

  findRoleIdByCode(code: string, db: Db = this.prisma): Promise<{ id: string } | null> {
    return db.role.findUnique({ where: { code }, select: { id: true } });
  }

  async assignRole(userId: string, roleId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.userRole.create({ data: { userId, roleId }, select: { userId: true } });
  }

  /** Reference-data upserts for the seed. Idempotent: safe to run on every deploy. */
  async upsertRole(code: string, name: string): Promise<string> {
    const role = await this.prisma.role.upsert({
      where: { code },
      create: { code, name },
      update: { name },
      select: { id: true },
    });
    return role.id;
  }

  async upsertPermission(code: string, description: string): Promise<string> {
    const permission = await this.prisma.permission.upsert({
      where: { code },
      create: { code, description },
      update: { description },
      select: { id: true },
    });
    return permission.id;
  }

  async ensureRolePermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await this.prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    });
  }

  countUsersWithRole(roleCode: string): Promise<number> {
    return this.prisma.userRole.count({ where: { role: { code: roleCode } } });
  }

  /** Role codes and the union of their permission codes in one query (no N+1). */
  async getRoleAndPermissionCodes(userId: string): Promise<RoleAndPermissions> {
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

  // --- administration of accounts and roles (Module 18) -------------------------------------------------------

  async listUsers(
    filter: { type?: UserType; status?: UserStatus },
    skip: number,
    take: number,
  ): Promise<{ items: UserRecord[]; total: number }> {
    const where: Prisma.UserWhereInput = {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  /** Role codes per user for a page of users in ONE query. */
  async roleCodesFor(userIds: string[]): Promise<Map<string, string[]>> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, role: { select: { code: true } } },
    });
    const byUser = new Map<string, string[]>();
    for (const row of rows) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.role.code].sort());
    }
    return byUser;
  }

  /** Serialises every change to who holds the Super Admin role (role changes, last-Super-Admin protection). */
  async lockSuperAdminAssignments(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sevanest.super_admin_assignments'))`;
  }

  async activeSuperAdminCount(tx: Prisma.TransactionClient): Promise<number> {
    return tx.userRole.count({
      where: { role: { code: 'SUPER_ADMIN' }, user: { status: 'ACTIVE', type: 'ADMIN' } },
    });
  }

  async roleCodesOf(userId: string, db: Db = this.prisma): Promise<string[]> {
    const rows = await db.userRole.findMany({
      where: { userId },
      select: { role: { select: { code: true } } },
    });
    return rows.map((r) => r.role.code).sort();
  }

  async replaceUserRole(
    userId: string,
    roleId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.userRole.deleteMany({ where: { userId } });
    await tx.userRole.create({ data: { userId, roleId }, select: { userId: true } });
  }

  async listRoles(): Promise<
    Array<{ id: string; code: string; name: string; permissionCodes: string[]; userCount: number }>
  > {
    const roles = await this.prisma.role.findMany({
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        permissions: { select: { permission: { select: { code: true } } } },
        _count: { select: { users: true } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      permissionCodes: r.permissions.map((p) => p.permission.code).sort(),
      userCount: r._count.users,
    }));
  }

  listPermissions(): Promise<Array<{ id: string; code: string; description: string | null }>> {
    return this.prisma.permission.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, description: true },
    });
  }

  /** Locks the role row for the rest of the transaction so concurrent permission edits serialise. */
  async lockRoleByCode(
    code: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; code: string; name: string } | null> {
    await tx.$queryRaw`SELECT id FROM roles WHERE code = ${code} FOR UPDATE`;
    return tx.role.findUnique({ where: { code }, select: { id: true, code: true, name: true } });
  }

  async permissionCodesOfRole(roleId: string, db: Db): Promise<string[]> {
    const rows = await db.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    return rows.map((r) => r.permission.code).sort();
  }

  async findPermissionIdsByCodes(codes: string[], db: Db): Promise<Map<string, string>> {
    const rows = await db.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    return new Map(rows.map((r) => [r.code, r.id]));
  }

  async replaceRolePermissions(
    roleId: string,
    permissionIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.rolePermission.deleteMany({ where: { roleId } });
    await tx.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
    });
  }
}
