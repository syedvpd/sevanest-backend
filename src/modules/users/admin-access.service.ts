import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Page, skipFor } from '../../common/pagination/pagination';
import { maskMobile } from '../../common/validation/indian-mobile';
import type {
  AdminUserListItem,
  AdminUserListQuery,
  PermissionView,
  RoleView,
} from './dto/admin-access.dto';
import {
  AdminRoleCode,
  AdminRoleCodeValue,
  SUPER_ADMIN_ONLY_PERMISSION_CODES,
} from './rbac.constants';
import { UsersRepository } from './users.repository';
import type { UserRecord } from './users.types';

export const AdminAccessErrorCode = {
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  NOT_AN_ADMIN: 'NOT_AN_ADMIN',
  CANNOT_CHANGE_OWN_ROLE: 'CANNOT_CHANGE_OWN_ROLE',
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  ROLE_IMMUTABLE: 'ROLE_IMMUTABLE',
  PERMISSION_UNKNOWN: 'PERMISSION_UNKNOWN',
  PERMISSION_RESTRICTED: 'PERMISSION_RESTRICTED',
} as const;

export interface AccessActor {
  userId: string;
  roles: string[];
}

const forbidden = (): DomainException =>
  new DomainException(
    ErrorCode.FORBIDDEN,
    'You do not have permission to perform this action',
    HttpStatus.FORBIDDEN,
  );

function maskedAdminView(user: UserRecord, roles: string[]): AdminUserListItem {
  return {
    id: user.id,
    type: user.type,
    status: user.status,
    mobile: maskMobile(user.mobile),
    email: user.email,
    roles,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Administration of admin accounts, roles and role-permission mapping (FRD FM-15/FM-16, FR-ADM-001, FR-SEC-001). The mapping of
 * permissions to the three non-Super roles is deliberately DATA that the Super Admin sets here, because the specification gives
 * only a proposed matrix (Q-11, Q-33). Privilege escalation is closed in code, not left to convention:
 *   - the SUPER_ADMIN role is immutable and always holds the full catalog;
 *   - the permissions that administer administration (`role.manage`, `audit.view`, `admin.manage_users`) can never be mapped
 *     to any other role;
 *   - only a Super Admin may create, promote or demote a Super Admin, nobody changes their own role, and the last active Super
 *     Admin cannot be demoted.
 * Role changes apply on the next request because authorization is read from the database on every request.
 */
@Injectable()
export class AdminAccessService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly audit: AuditService,
  ) {}

  async listUsers(query: AdminUserListQuery): Promise<Page<AdminUserListItem>> {
    const { items, total } = await this.repository.listUsers(
      { type: query.type, status: query.status },
      skipFor(query),
      query.limit,
    );
    const roles = await this.repository.roleCodesFor(items.map((u) => u.id));
    return {
      data: items.map((u) => maskedAdminView(u, roles.get(u.id) ?? [])),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async listRoles(): Promise<RoleView[]> {
    const roles = await this.repository.listRoles();
    return roles.map(({ code, name, permissionCodes, userCount }) => ({
      code,
      name,
      permissionCodes,
      userCount,
    }));
  }

  async listPermissions(): Promise<PermissionView[]> {
    const permissions = await this.repository.listPermissions();
    return permissions.map((p) => ({
      code: p.code,
      description: p.description,
      superAdminOnly: SUPER_ADMIN_ONLY_PERMISSION_CODES.includes(p.code),
    }));
  }

  async getRole(code: string): Promise<RoleView> {
    const role = (await this.listRoles()).find((r) => r.code === code);
    if (!role) throw this.roleNotFound();
    return role;
  }

  /** Replaces the full set of permissions a role holds. Repeating the same set changes nothing and writes no audit record. */
  async setRolePermissions(
    roleCode: string,
    permissionCodes: string[],
    actor: AccessActor,
  ): Promise<RoleView> {
    const wanted = [...new Set(permissionCodes)].sort();
    if (roleCode === AdminRoleCode.SUPER_ADMIN) {
      throw new DomainException(
        AdminAccessErrorCode.ROLE_IMMUTABLE,
        'The Super Admin role always holds every permission and cannot be edited',
        HttpStatus.CONFLICT,
      );
    }
    const restricted = wanted.filter((c) => SUPER_ADMIN_ONLY_PERMISSION_CODES.includes(c));
    if (restricted.length > 0) {
      throw new DomainException(
        AdminAccessErrorCode.PERMISSION_RESTRICTED,
        'These permissions can only be held by the Super Admin role',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'permissionCodes', messages: restricted.map((c) => `${c} is restricted`) }],
      );
    }
    await this.repository.transaction(async (tx) => {
      const role = await this.repository.lockRoleByCode(roleCode, tx);
      if (!role) throw this.roleNotFound();
      const ids = await this.repository.findPermissionIdsByCodes(wanted, tx);
      const unknown = wanted.filter((c) => !ids.has(c));
      if (unknown.length > 0) {
        throw new DomainException(
          AdminAccessErrorCode.PERMISSION_UNKNOWN,
          'Unknown permission codes',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: 'permissionCodes', messages: unknown.map((c) => `${c} does not exist`) }],
        );
      }
      const current = await this.repository.permissionCodesOfRole(role.id, tx);
      const added = wanted.filter((c) => !current.includes(c));
      const removed = current.filter((c) => !wanted.includes(c));
      if (added.length === 0 && removed.length === 0) return;
      await this.repository.replaceRolePermissions(
        role.id,
        wanted.map((c) => ids.get(c)!),
        tx,
      );
      await this.audit.record(
        {
          action: 'role.permissions_set',
          entityType: 'role',
          entityId: role.id,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: { roleCode, added, removed },
        },
        tx,
      );
    });
    return this.getRole(roleCode);
  }

  /** Moves an admin account to another role. One role per admin account (as on creation). */
  async changeAdminRole(
    targetUserId: string,
    roleCode: AdminRoleCodeValue,
    reason: string | undefined,
    actor: AccessActor,
  ): Promise<AdminUserListItem> {
    if (targetUserId === actor.userId) {
      throw new DomainException(
        AdminAccessErrorCode.CANNOT_CHANGE_OWN_ROLE,
        'You cannot change your own role',
        HttpStatus.CONFLICT,
      );
    }
    const result = await this.repository.transaction(async (tx) => {
      await this.repository.lockSuperAdminAssignments(tx);
      const target = await this.repository.lockById(targetUserId, tx);
      if (!target) {
        throw new DomainException(
          AdminAccessErrorCode.USER_NOT_FOUND,
          'User not found',
          HttpStatus.NOT_FOUND,
        );
      }
      if (target.type !== 'ADMIN') {
        throw new DomainException(
          AdminAccessErrorCode.NOT_AN_ADMIN,
          'Roles can only be assigned to admin accounts',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const role = await this.repository.findRoleIdByCode(roleCode, tx);
      if (!role) {
        throw new DomainException(
          AdminAccessErrorCode.ROLE_NOT_FOUND,
          'The requested role does not exist',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const before = await this.repository.roleCodesOf(targetUserId, tx);
      if (before.length === 1 && before[0] === roleCode) {
        return { user: target, roles: before, changed: false };
      }
      // The actor's CURRENT roles, read under the same lock: a role taken away a moment ago must not still authorise this.
      const actorIsSuper = (await this.repository.roleCodesOf(actor.userId, tx)).includes(
        AdminRoleCode.SUPER_ADMIN,
      );
      const touchesSuper =
        roleCode === AdminRoleCode.SUPER_ADMIN || before.includes(AdminRoleCode.SUPER_ADMIN);
      if (touchesSuper && !actorIsSuper) throw forbidden();
      if (
        before.includes(AdminRoleCode.SUPER_ADMIN) &&
        target.status === 'ACTIVE' &&
        (await this.repository.activeSuperAdminCount(tx)) <= 1
      ) {
        throw new DomainException(
          AdminAccessErrorCode.LAST_SUPER_ADMIN,
          'The last active Super Admin cannot be moved to another role',
          HttpStatus.CONFLICT,
        );
      }
      await this.repository.replaceUserRole(targetUserId, role.id, tx);
      await this.audit.record(
        {
          action: 'admin.role_change',
          entityType: 'user',
          entityId: targetUserId,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: { from: before, to: [roleCode], reason: reason ?? null },
        },
        tx,
      );
      return { user: target, roles: [roleCode], changed: true };
    });
    return maskedAdminView(result.user, result.roles);
  }

  private roleNotFound(): DomainException {
    return new DomainException(
      AdminAccessErrorCode.ROLE_NOT_FOUND,
      'Role not found',
      HttpStatus.NOT_FOUND,
    );
  }
}
