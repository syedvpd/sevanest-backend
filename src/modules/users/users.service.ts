import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { PasswordHasher } from '../../common/security/password-hasher.service';
import { AppConfigService } from '../../config/app-config.service';
import type { UserStatus, UserType } from '../../generated/prisma/client';
import { AdminRoleCodeValue, PermissionCode } from './rbac.constants';
import { UserEvents } from './user-events';
import { UsersRepository } from './users.repository';
import type { Actor, RoleAndPermissions, UserCredentialRecord, UserRecord } from './users.types';

export const UsersErrorCode = {
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  CANNOT_CHANGE_OWN_STATUS: 'CANNOT_CHANGE_OWN_STATUS',
  ADMIN_EMAIL_TAKEN: 'ADMIN_EMAIL_TAKEN',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
} as const;

export interface UserIdentity extends UserRecord, RoleAndPermissions {}

/** Common identity/account domain: who a user is, their type, status, roles and permissions. */
@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly audit: AuditService,
    private readonly events: UserEvents,
    private readonly hasher: PasswordHasher,
    private readonly config: AppConfigService,
  ) {}

  findById(id: string): Promise<UserRecord | null> {
    return this.repository.findById(id);
  }

  async getByIdOrThrow(id: string): Promise<UserRecord> {
    const user = await this.repository.findById(id);
    if (!user) {
      throw this.notFound();
    }
    return user;
  }

  findManyByIds(ids: string[]): Promise<UserRecord[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.repository.findManyByIds(ids);
  }

  findByMobile(mobile: string): Promise<UserRecord | null> {
    return this.repository.findByMobile(mobile);
  }

  /** Used by admin login only; the hash must never leave Auth. */
  findCredentialsByEmail(email: string): Promise<UserCredentialRecord | null> {
    return this.repository.findCredentialsByEmail(email);
  }

  getAccess(userId: string): Promise<RoleAndPermissions> {
    return this.repository.getRoleAndPermissionCodes(userId);
  }

  async getIdentity(userId: string): Promise<UserIdentity> {
    const [user, access] = await Promise.all([
      this.repository.findById(userId),
      this.repository.getRoleAndPermissionCodes(userId),
    ]);
    if (!user) {
      throw this.notFound();
    }
    return { ...user, ...access };
  }

  /**
   * First OTP verification for a mobile creates the account (FRD FM-01 "if the number is new"). Concurrent first
   * verifications race on the unique mobile; the loser re-reads the winner's row.
   */
  async findOrCreateByMobile(
    mobile: string,
    type: UserType,
  ): Promise<{ user: UserRecord; isNewUser: boolean }> {
    const existing = await this.repository.findByMobile(mobile);
    if (existing) {
      return { user: existing, isNewUser: false };
    }
    try {
      const user = await this.repository.transaction(async (tx) => {
        const created = await this.repository.create({ type, mobile }, tx);
        await this.audit.record(
          {
            action: 'user.register',
            entityType: 'user',
            entityId: created.id,
            actorId: created.id,
            metadata: { type },
          },
          tx,
        );
        return created;
      });
      return { user, isNewUser: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.repository.findByMobile(mobile);
        if (winner) {
          return { user: winner, isNewUser: false };
        }
      }
      throw error;
    }
  }

  /**
   * Creates an admin account (accounts are created by a Super Admin, FRD FM-01 preconditions). Authorization is
   * enforced by the caller (permission admin.manage_users); bootstrap passes a system actor. The password policy
   * is open (FR-AUTH-006), so only the configured minimum length is enforced.
   */
  async provisionAdmin(
    input: { email: string; password: string; roleCode: AdminRoleCodeValue },
    actor: Actor,
  ): Promise<UserRecord> {
    // Only a Super Admin (or the one-time development bootstrap) may create a Super Admin: no escalation by account creation.
    if (
      input.roleCode === 'SUPER_ADMIN' &&
      !actor.roles.includes('SUPER_ADMIN') &&
      !actor.roles.includes('SYSTEM_BOOTSTRAP')
    ) {
      throw new DomainException(
        ErrorCode.FORBIDDEN,
        'You do not have permission to perform this action',
        HttpStatus.FORBIDDEN,
      );
    }
    const minLength = this.config.adminLogin.passwordMinLength;
    if (input.password.length < minLength) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'password', messages: [`password must be at least ${minLength} characters`] }],
      );
    }
    const passwordHash = await this.hasher.hash(input.password);
    return this.createAdmin({ email: input.email, passwordHash, roleCode: input.roleCode }, actor);
  }

  private async createAdmin(
    input: { email: string; passwordHash: string; roleCode: AdminRoleCodeValue },
    actor: Actor,
  ): Promise<UserRecord> {
    const role = await this.repository.findRoleIdByCode(input.roleCode);
    if (!role) {
      throw new DomainException(
        UsersErrorCode.ROLE_NOT_FOUND,
        'The requested role does not exist',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    try {
      return await this.repository.transaction(async (tx) => {
        const user = await this.repository.create(
          { type: 'ADMIN', email: input.email, passwordHash: input.passwordHash },
          tx,
        );
        await this.repository.assignRole(user.id, role.id, tx);
        await this.audit.record(
          {
            action: 'admin.create',
            entityType: 'user',
            entityId: user.id,
            actorId: actor.userId,
            actorRole: actor.roles.join(',') || null,
            metadata: { roleCode: input.roleCode },
          },
          tx,
        );
        return user;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          UsersErrorCode.ADMIN_EMAIL_TAKEN,
          'An account with this email already exists',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /**
   * Suspends or reactivates a user (FR-SEC-007, FM-02). The row is locked so concurrent changes serialise; the
   * audit record commits with the change; sessions are revoked after commit via UserEvents (and the auth guard
   * rejects suspended users on every request regardless).
   */
  async changeStatus(
    targetId: string,
    status: UserStatus,
    reason: string | undefined,
    actor: Actor & { userId: string },
    actorPermissions: string[],
  ): Promise<UserRecord> {
    if (actor.userId === targetId) {
      throw new DomainException(
        UsersErrorCode.CANNOT_CHANGE_OWN_STATUS,
        'You cannot change your own account status',
        HttpStatus.CONFLICT,
      );
    }
    const result = await this.repository.transaction(async (tx) => {
      const before = await this.repository.lockById(targetId, tx);
      if (!before) {
        throw this.notFound();
      }
      if (
        before.type === 'ADMIN' &&
        !actorPermissions.includes(PermissionCode.ADMIN_MANAGE_USERS)
      ) {
        throw new DomainException(
          ErrorCode.FORBIDDEN,
          'You do not have permission to perform this action',
          HttpStatus.FORBIDDEN,
        );
      }
      if (before.status === status) {
        return { user: before, changed: false, from: before.status };
      }
      const user = await this.repository.updateStatus(targetId, status, tx);
      await this.audit.record(
        {
          action: 'user.status_change',
          entityType: 'user',
          entityId: targetId,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: {
            from: before.status,
            to: status,
            userType: before.type,
            reason: reason ?? null,
          },
        },
        tx,
      );
      return { user, changed: true, from: before.status };
    });
    if (result.changed) {
      this.events.emitStatusChanged({
        userId: targetId,
        from: result.from,
        to: status,
        actorId: actor.userId,
      });
    }
    return result.user;
  }

  private notFound(): DomainException {
    return new DomainException(
      UsersErrorCode.USER_NOT_FOUND,
      'User not found',
      HttpStatus.NOT_FOUND,
    );
  }
}
