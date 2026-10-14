import { Injectable } from '@nestjs/common';
import {
  ADMIN_ROLES,
  AdminRoleCode,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  SUPER_ADMIN_PERMISSION_CODES,
} from './rbac.constants';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

export interface SeedSummary {
  roles: number;
  permissions: number;
  superAdminPermissions: number;
  /** Roles that received their D-71 starting permissions in this run (they held none before). */
  rolesGivenDefaults: string[];
}

/**
 * Reproducible reference data for RBAC: the four admin roles (PRD), the permission catalog, the Super Admin mapping and the
 * D-71 least-privilege starting sets of the other roles (applied only to a role that holds no permission yet).
 */
@Injectable()
export class RbacSeedService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly users: UsersService,
  ) {}

  async ensureReferenceData(options: { roleDefaults?: boolean } = {}): Promise<SeedSummary> {
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
    const rolesGivenDefaults: string[] = [];
    if (options.roleDefaults !== false) {
      for (const [code, permissionCodes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        const roleId = roleIds.get(code)!;
        if ((await this.repository.countRolePermissions(roleId)) > 0) continue;
        await this.repository.ensureRolePermissions(
          roleId,
          permissionCodes.map((permissionCode) => permissionIds.get(permissionCode)!),
        );
        rolesGivenDefaults.push(code);
      }
    }
    return {
      roles: roleIds.size,
      permissions: permissionIds.size,
      superAdminPermissions: SUPER_ADMIN_PERMISSION_CODES.length,
      rolesGivenDefaults,
    };
  }

  /**
   * One-time bootstrap of the first Super Admin from caller-supplied credentials (read from the environment by the
   * operator CLI; never stored in the repository). Returns false when a Super Admin already exists. Atomic and audited.
   */
  async bootstrapSuperAdmin(email: string, password: string): Promise<boolean> {
    return (await this.users.bootstrapFirstSuperAdmin({ email, password })) === 'CREATED';
  }
}
