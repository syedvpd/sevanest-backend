import { HttpStatus, Injectable } from '@nestjs/common';
import { assertIfMatch } from '../../common/concurrency/if-match';
import { randomInt } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { PasswordHasher } from '../../common/security/password-hasher.service';
import { AppConfigService } from '../../config/app-config.service';
import type { Prisma, UserStatus, UserType } from '../../generated/prisma/client';
import { AdminRoleCodeValue, PermissionCode } from './rbac.constants';
import { UserEvents } from './user-events';
import { UsersRepository } from './users.repository';
import type { Actor, RoleAndPermissions, UserCredentialRecord, UserRecord } from './users.types';

export const UsersErrorCode = {
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  CANNOT_CHANGE_OWN_STATUS: 'CANNOT_CHANGE_OWN_STATUS',
  ADMIN_EMAIL_TAKEN: 'ADMIN_EMAIL_TAKEN',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  NOT_AN_ADMIN: 'NOT_AN_ADMIN',
  USE_CHANGE_PASSWORD: 'USE_CHANGE_PASSWORD',
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

  /** Used by the admin password change only; the hash must never leave Auth. */
  findCredentialsById(id: string): Promise<UserCredentialRecord | null> {
    return this.repository.findCredentialsById(id);
  }

  /** Minimum length is configuration (ADMIN_PASSWORD_MIN_LENGTH); throws 400 when the candidate is shorter. */
  assertPasswordMeetsPolicy(password: string, field = 'password'): void {
    const minLength = this.config.adminLogin.passwordMinLength;
    if (password.length < minLength) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field, messages: [`${field} must be at least ${minLength} characters`] }],
      );
    }
  }

  hashPassword(password: string): Promise<string> {
    return this.hasher.hash(password);
  }

  setPasswordHash(
    userId: string,
    passwordHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    return this.repository.updatePasswordHash(userId, passwordHash, tx);
  }

  /**
   * A Super Admin sets a new temporary password for ANOTHER admin who is locked out or forgot theirs (there is no self-service reset: it
   * would need a delivery channel and an MFA decision). The password is random, shown once to the caller, never stored in clear or audited;
   * every session of that admin is revoked, and they should change it at once with POST /admin/account/password.
   */
  async resetAdminPassword(
    targetUserId: string,
    actor: Actor & { userId: string },
  ): Promise<{ temporaryPassword: string }> {
    const target = await this.getByIdOrThrow(targetUserId);
    if (target.type !== 'ADMIN') {
      throw new DomainException(
        UsersErrorCode.NOT_AN_ADMIN,
        'Only an admin account has a password',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (target.id === actor.userId) {
      throw new DomainException(
        UsersErrorCode.USE_CHANGE_PASSWORD,
        'Use the change-password endpoint for your own account',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);
    await this.repository.transaction(async (tx) => {
      await this.repository.updatePasswordHash(target.id, passwordHash, tx);
      await this.audit.record(
        {
          action: 'admin.password_reset',
          entityType: 'user',
          entityId: target.id,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
        },
        tx,
      );
    });
    this.events.emitPasswordReset({ userId: target.id });
    return { temporaryPassword };
  }

  private generateTemporaryPassword(): string {
    const pick = (chars: string): string => chars[randomInt(chars.length)];
    const sets = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKMNPQRSTUVWXYZ', '23456789', '!@#%*-_'];
    const all = sets.join('');
    const length = Math.max(20, this.config.adminLogin.passwordMinLength);
    const chars = sets.map(pick);
    while (chars.length < length) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  getAccess(userId: string): Promise<RoleAndPermissions> {
    return this.repository.getRoleAndPermissionCodes(userId);
  }

  /** DEC-17: does this user want e-mail notifications (only used when an e-mail address is on file). */
  async getEmailPreference(userId: string): Promise<boolean> {
    const value = await this.repository.emailNotifications(userId);
    if (value === null) throw this.notFound();
    return value;
  }

  async setEmailPreference(userId: string, value: boolean): Promise<boolean> {
    await this.getEmailPreference(userId);
    await this.repository.setEmailNotifications(userId, value);
    return value;
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

  /**
   * One-time creation of the first Super Admin (operator CLI `npm run bootstrap:admin`, never an HTTP route).
   * Atomic under the Super-Admin advisory lock, so two concurrent runs create at most one. Refused when ANY Super Admin
   * assignment exists (even a suspended account). Both outcomes are audited; the audit rows never hold the email or password.
   */
  async bootstrapFirstSuperAdmin(input: {
    email: string;
    password: string;
  }): Promise<'CREATED' | 'ALREADY_BOOTSTRAPPED'> {
    const minLength = this.config.adminLogin.passwordMinLength;
    if (input.password.length < minLength) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'password', messages: [`password must be at least ${minLength} characters`] }],
      );
    }
    const role = await this.repository.findRoleIdByCode('SUPER_ADMIN');
    if (!role) {
      throw new DomainException(
        UsersErrorCode.ROLE_NOT_FOUND,
        'The SUPER_ADMIN role does not exist; run the seed first',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const passwordHash = await this.hasher.hash(input.password);
    const actor = { actorId: null, actorRole: 'SYSTEM_BOOTSTRAP' };
    try {
      const outcome = await this.repository.transaction(async (tx) => {
        await this.repository.lockSuperAdminAssignments(tx);
        if ((await this.repository.superAdminAssignmentCount(tx)) > 0)
          return 'ALREADY_BOOTSTRAPPED' as const;
        const user = await this.repository.create(
          { type: 'ADMIN', email: input.email, passwordHash },
          tx,
        );
        await this.repository.assignRole(user.id, role.id, tx);
        await this.audit.record(
          {
            action: 'admin.bootstrap',
            entityType: 'user',
            entityId: user.id,
            ...actor,
            metadata: { roleCode: 'SUPER_ADMIN' },
          },
          tx,
        );
        return 'CREATED' as const;
      });
      if (outcome === 'ALREADY_BOOTSTRAPPED') {
        await this.audit.record({
          action: 'admin.bootstrap_rejected',
          entityType: 'user',
          ...actor,
          metadata: { reason: 'SUPER_ADMIN_EXISTS' },
        });
      }
      return outcome;
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.audit.record({
          action: 'admin.bootstrap_rejected',
          entityType: 'user',
          ...actor,
          metadata: { reason: 'EMAIL_TAKEN' },
        });
        throw new DomainException(
          UsersErrorCode.ADMIN_EMAIL_TAKEN,
          'An account with this email already exists',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
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
    ifMatch?: string,
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
      assertIfMatch(ifMatch, before.updatedAt);
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
