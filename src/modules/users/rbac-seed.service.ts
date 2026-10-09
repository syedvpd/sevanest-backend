import { Injectable } from '@nestjs/common';
import {
  ADMIN_ROLES,
  AdminRoleCode,
  PERMISSION_CATALOG,
  SUPER_ADMIN_PERMISSION_CODES,
} from './rbac.constants';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

export interface SeedSummary {
  roles: number;
  permissions: number;
  superAdminPermissions: number;
}

/**
 * Reproducible reference data for RBAC: the four admin roles (PRD), the permission codes Modules 1-3 need, and the
 * Super Admin mapping. The remaining role-to-permission mappings are an OPEN decision (Q-11) and are deliberately absent.
 */
@Injectable()
export class RbacSeedService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly users: UsersService,
  ) {}

  async ensureReferenceData(): Promise<SeedSummary> {
    const roleIds = new Map<string, string>();
    for (const role of ADMIN_ROLES) {
      roleIds.set(role.code, await this.repository.upsertRole(role.code, role.name));
    }
    const permissionIds = new Map<string, string>();
    for (const permission of PERMISSION_CATALOG) {
      permissionIds.set(
        permission.code,
        await this.repository.upsertPermission(permission.code, permission.description),
      );
    }
    const superAdminRoleId = roleIds.get(AdminRoleCode.SUPER_ADMIN)!;
    await this.repository.ensureRolePermissions(
      superAdminRoleId,
      SUPER_ADMIN_PERMISSION_CODES.map((code) => permissionIds.get(code)!),
    );
    return {
      roles: roleIds.size,
      permissions: permissionIds.size,
      superAdminPermissions: SUPER_ADMIN_PERMISSION_CODES.length,
    };
  }

  /**
   * Development-only bootstrap of the first Super Admin from caller-supplied credentials (read from the environment by
   * the seed entry point; never stored in the repository). Returns false when a Super Admin already exists.
   */
  async bootstrapSuperAdmin(email: string, password: string): Promise<boolean> {
    if ((await this.repository.countUsersWithRole(AdminRoleCode.SUPER_ADMIN)) > 0) {
      return false;
    }
    await this.users.provisionAdmin(
      { email, password, roleCode: AdminRoleCode.SUPER_ADMIN },
      { userId: null, roles: ['SYSTEM_BOOTSTRAP'] },
    );
    return true;
  }
}
