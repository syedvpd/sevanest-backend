import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { PasswordHasher } from '../../common/security/password-hasher.service';
import type { UserType } from '../../generated/prisma/client';
import { UsersService } from '../users/users.service';
import type { UserRecord } from '../users/users.types';
import { AdminLoginThrottle } from './admin-login-throttle.service';
import { AuthErrorCode } from './auth.errors';
import { OtpIssueResult, OtpService } from './otp.service';
import { DeviceInfo, IssuedTokens, SessionService } from './session.service';

export type AppType = 'CUSTOMER' | 'WORKER';

export interface LoginResult extends IssuedTokens {
  user: { id: string; type: UserType; isNewUser: boolean; roles?: string[] };
}

/** Authentication use cases (FR-AUTH-001..005). Delegates storage to Users/Sessions; owns the login rules. */
@Injectable()
export class AuthService {
  constructor(
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly hasher: PasswordHasher,
    private readonly throttle: AdminLoginThrottle,
    private readonly audit: AuditService,
  ) {}

  /** The app that asks for the OTP decides the account type (FRD FM-01: "the app type determines the user type"). */
  requestOtp(mobile: string, appType: AppType, clientIp: string): Promise<OtpIssueResult> {
    return this.otp.issue(mobile, clientIp, async () => {
      const existing = await this.users.findByMobile(mobile);
      if (existing) {
        this.assertCanLogin(existing, appType);
      }
    });
  }

  async verifyOtp(
    input: { mobile: string; otp: string; appType: AppType },
    device: DeviceInfo,
  ): Promise<LoginResult> {
    try {
      await this.otp.verify(input.mobile, input.otp);
    } catch (error) {
      await this.auditOtpFailure(error, input.appType);
      throw error;
    }

    const { user, isNewUser } = await this.users.findOrCreateByMobile(input.mobile, input.appType);
    this.assertCanLogin(user, input.appType);

    const tokens = await this.sessions.startSession(user.id, device);
    await this.audit.record({
      action: 'auth.login',
      entityType: 'session',
      entityId: tokens.sessionId,
      actorId: user.id,
      metadata: { method: 'otp', appType: input.appType, isNewUser },
    });
    return { ...tokens, user: { id: user.id, type: user.type, isNewUser } };
  }

  async adminLogin(
    input: { email: string; password: string },
    clientIp: string,
    device: DeviceInfo,
  ): Promise<LoginResult> {
    const accountKey = AdminLoginThrottle.accountKey(input.email);
    await this.throttle.assertNotLocked(accountKey, clientIp);

    const user = await this.users.findCredentialsByEmail(input.email);
    const isAdminWithPassword = user?.type === 'ADMIN' && user.passwordHash !== null;
    // Always spend one hash verification so timing does not reveal whether the email exists.
    const stored = isAdminWithPassword ? user.passwordHash! : await this.hasher.dummyHash();
    const passwordOk = await this.hasher.verify(input.password, stored);

    if (!isAdminWithPassword || !passwordOk) {
      const lockedOut = await this.throttle.recordFailure(accountKey, clientIp);
      if (user?.type === 'ADMIN') {
        await this.audit.record({
          action: 'auth.admin_login_failed',
          entityType: 'user',
          entityId: user.id,
          actorId: user.id,
          metadata: { reason: 'bad_credentials', lockedOut },
        });
      }
      throw new DomainException(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Invalid email or password',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        action: 'auth.admin_login_failed',
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        metadata: { reason: 'suspended' },
      });
      throw this.suspended();
    }

    await this.throttle.reset(accountKey);
    const [tokens, access] = await Promise.all([
      this.sessions.startSession(user.id, device),
      this.users.getAccess(user.id),
    ]);
    await this.audit.record({
      action: 'auth.login',
      entityType: 'session',
      entityId: tokens.sessionId,
      actorId: user.id,
      actorRole: access.roles.join(',') || null,
      metadata: { method: 'password' },
    });
    return {
      ...tokens,
      user: { id: user.id, type: user.type, isNewUser: false, roles: access.roles },
    };
  }

  /**
   * Wrong-OTP attempts and the lockout they trigger are security events. Only the failure kind and the app are recorded: no
   * mobile number, no code. Repeat attempts while already locked and expiry are not recorded (they add volume, not signal).
   */
  private async auditOtpFailure(error: unknown, appType: AppType): Promise<void> {
    const code = error instanceof DomainException ? error.code : undefined;
    if (code !== AuthErrorCode.OTP_INVALID && code !== AuthErrorCode.OTP_ATTEMPTS_EXCEEDED) return;
    await this.audit.record({
      action: 'auth.otp_failed',
      entityType: 'otp',
      metadata: { reason: code, appType },
    });
  }

  private assertCanLogin(user: UserRecord, appType: AppType): void {
    if (user.type !== appType) {
      // One mobile = one account (open product decision). Admin accounts never use OTP.
      throw new DomainException(
        AuthErrorCode.ACCOUNT_TYPE_MISMATCH,
        'This mobile number is registered for a different type of account',
        HttpStatus.CONFLICT,
      );
    }
    if (user.status !== 'ACTIVE') {
      throw this.suspended();
    }
  }

  private suspended(): DomainException {
    return new DomainException(
      AuthErrorCode.ACCOUNT_SUSPENDED,
      'This account is suspended',
      HttpStatus.FORBIDDEN,
    );
  }
}
