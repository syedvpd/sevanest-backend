import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { AppConfigService } from '../../config/app-config.service';
import type { DevicePlatform, UserType } from '../../generated/prisma/client';
import { UserEvents } from '../users/user-events';
import { UsersService } from '../users/users.service';
import { AuthErrorCode } from './auth.errors';
import { SessionRepository, SessionSummary } from './session.repository';
import { TokenService } from './token.service';

export interface DeviceInfo {
  deviceId?: string;
  deviceName?: string;
}

export interface IssuedTokens {
  userId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

/**
 * Session lifecycle (FR-AUTH-003, BEA p5): one row per device session, opaque refresh token stored only as a hash and
 * rotated on every use, replay of a rotated token revokes the session, logout and suspension revoke sessions.
 */
@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly repository: SessionRepository,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly userEvents: UserEvents,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    // A suspended account loses every session. The guard already rejects it on each request; this removes the rows too.
    this.userEvents.onStatusChanged(async (event) => {
      if (event.to === 'SUSPENDED') {
        const count = await this.revokeAllForUser(event.userId);
        this.logger.log(`Revoked ${count} session(s) after suspension of user ${event.userId}`);
      }
    });
  }

  /** Creates a session and returns the first token pair. A new login on the same device replaces its previous session. */
  async startSession(userId: string, device: DeviceInfo = {}): Promise<IssuedTokens> {
    const refreshToken = this.tokens.generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000);
    const create = (): Promise<string> =>
      this.repository.transaction(async (tx) => {
        if (device.deviceId) {
          await this.repository.revokeActiveForDevice(userId, device.deviceId, tx);
        }
        return this.repository.create(
          {
            userId,
            refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
            expiresAt,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
          },
          tx,
        );
      });

    let sessionId: string;
    try {
      sessionId = await create();
    } catch (error) {
      if (!isUniqueViolation(error) || !device.deviceId) {
        throw error;
      }
      sessionId = await create(); // lost a race with a parallel login on the same device; revoke it and retry once
    }
    return this.issue(userId, sessionId, refreshToken);
  }

  /**
   * Exchanges a refresh token for a new pair. The old token stops working. Presenting an already-rotated token is
   * treated as possible theft: the session is revoked and an audit event is written (deterministic, no grace period).
   */
  async refresh(refreshToken: string): Promise<IssuedTokens & { userType: UserType }> {
    const oldHash = this.tokens.hashRefreshToken(refreshToken);
    const newToken = this.tokens.generateRefreshToken();
    const rotated = await this.repository.rotate(
      oldHash,
      this.tokens.hashRefreshToken(newToken),
      new Date(),
    );

    if (!rotated) {
      const replayed = await this.repository.findActiveByPreviousHash(oldHash);
      if (replayed) {
        await this.repository.transaction(async (tx) => {
          await this.repository.revoke({ id: replayed.id }, tx);
          await this.audit.record(
            {
              action: 'auth.refresh_token_reuse',
              entityType: 'session',
              entityId: replayed.id,
              actorId: replayed.userId,
              metadata: { outcome: 'session_revoked' },
            },
            tx,
          );
        });
      }
      throw this.invalidRefreshToken();
    }

    const user = await this.users.findById(rotated.userId);
    if (!user || user.status !== 'ACTIVE') {
      await this.repository.transaction((tx) =>
        this.repository.revoke({ id: rotated.sessionId }, tx),
      );
      throw new DomainException(
        AuthErrorCode.ACCOUNT_SUSPENDED,
        'This account is suspended',
        HttpStatus.FORBIDDEN,
      );
    }
    return {
      ...(await this.issue(rotated.userId, rotated.sessionId, newToken)),
      userType: user.type,
    };
  }

  /** Logout / explicit revoke of the caller's current session. Idempotent. */
  async revokeCurrent(userId: string, sessionId: string): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const revoked = await this.repository.revoke({ id: sessionId, userId }, tx);
      if (revoked) {
        await this.audit.record(
          { action: 'auth.logout', entityType: 'session', entityId: sessionId, actorId: userId },
          tx,
        );
      }
    });
  }

  /** Revokes one of the caller's OWN sessions. Another user's session id is reported as not found (no existence leak). */
  async revokeOwn(userId: string, sessionId: string): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const revoked = await this.repository.revoke({ id: sessionId, userId }, tx);
      if (!revoked) {
        throw new DomainException(
          AuthErrorCode.SESSION_NOT_FOUND,
          'Session not found',
          HttpStatus.NOT_FOUND,
        );
      }
      await this.audit.record(
        {
          action: 'auth.session_revoke',
          entityType: 'session',
          entityId: sessionId,
          actorId: userId,
        },
        tx,
      );
    });
  }

  revokeAllForUser(userId: string): Promise<number> {
    return this.repository.transaction((tx) => this.repository.revokeAllForUser(userId, tx));
  }

  listActive(userId: string): Promise<SessionSummary[]> {
    return this.repository.listActive(userId, new Date());
  }

  /** Contract for Notifications: where a push can be delivered for this user. */
  listDeviceTokens(userId: string): Promise<string[]> {
    return this.repository.listDeviceTokens(userId);
  }

  /** Binds the push token to the caller's current session so pushes stop after logout. */
  async registerDeviceToken(
    userId: string,
    sessionId: string,
    token: string,
    platform: DevicePlatform,
  ): Promise<void> {
    const bind = (): Promise<void> =>
      this.repository.transaction((tx) =>
        this.repository.bindDeviceToken({ userId, sessionId, token, platform }, tx),
      );
    try {
      await bind();
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      await bind(); // raced with another session binding the same token; the retry moves it
    }
  }

  private async issue(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<IssuedTokens> {
    const accessToken = await this.tokens.signAccessToken({ sub: userId, sid: sessionId });
    return {
      userId,
      sessionId,
      accessToken,
      refreshToken,
      expiresIn: this.config.jwtAccessTtlSeconds,
    };
  }

  private invalidRefreshToken(): DomainException {
    return new DomainException(
      AuthErrorCode.REFRESH_TOKEN_INVALID,
      'The refresh token is invalid or expired. Please sign in again.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
