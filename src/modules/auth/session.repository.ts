import { Injectable } from '@nestjs/common';
import type { DevicePlatform, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface SessionSummary {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

export interface RotatedSession {
  sessionId: string;
  userId: string;
}

/** The only place that reads or writes `sessions` (beyond the foundation's read-only active-session lookup) and `device_tokens`. */
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async create(
    data: {
      userId: string;
      refreshTokenHash: string;
      expiresAt: Date;
      deviceId?: string;
      deviceName?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const session = await tx.session.create({ data, select: { id: true } });
    return session.id;
  }

  /** A device has at most one active session: revoke the previous one(s) and drop their push tokens. */
  async revokeActiveForDevice(
    userId: string,
    deviceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const stale = await tx.session.findMany({
      where: { userId, deviceId, revokedAt: null },
      select: { id: true },
    });
    if (stale.length === 0) {
      return;
    }
    const ids = stale.map((s) => s.id);
    await tx.session.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } });
    await tx.deviceToken.deleteMany({ where: { sessionId: { in: ids } } });
  }

  /**
   * Atomic rotation: succeeds only for the CURRENT refresh token of an unrevoked, unexpired session, so two
   * concurrent refreshes cannot both win. The replaced hash is kept to detect replay of a rotated token.
   */
  async rotate(oldHash: string, newHash: string, now: Date): Promise<RotatedSession | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; user_id: string }>>`
      UPDATE sessions
         SET refresh_token_hash = ${newHash},
             previous_refresh_token_hash = ${oldHash},
             last_used_at = ${now}
       WHERE refresh_token_hash = ${oldHash}
         AND revoked_at IS NULL
         AND expires_at > ${now}
      RETURNING id, user_id`;
    return rows.length === 1 ? { sessionId: rows[0].id, userId: rows[0].user_id } : null;
  }

  /** An unrevoked session whose PREVIOUS token is this one: the token was already rotated, so this is a replay. */
  findActiveByPreviousHash(hash: string): Promise<{ id: string; userId: string } | null> {
    return this.prisma.session.findFirst({
      where: { previousRefreshTokenHash: hash, revokedAt: null },
      select: { id: true, userId: true },
    });
  }

  /** Revokes one session (idempotent) and removes its push token. Returns true if it was newly revoked. */
  async revoke(
    where: { id: string; userId?: string },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.session.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      await tx.deviceToken.deleteMany({ where: { sessionId: where.id } });
    }
    return result.count > 0;
  }

  async revokeAllForUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const active = await tx.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    if (active.length === 0) {
      return 0;
    }
    const ids = active.map((s) => s.id);
    await tx.session.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } });
    await tx.deviceToken.deleteMany({ where: { sessionId: { in: ids } } });
    return ids.length;
  }

  listActive(userId: string, now: Date): Promise<SessionSummary[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  /** Push tokens of a user's signed-in sessions (a token disappears when its session ends). */
  async listDeviceTokens(userId: string): Promise<string[]> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.token);
  }

  /** Binds a push token to exactly one session. A token already bound elsewhere (reinstall, other user) is moved. */
  async bindDeviceToken(
    input: { userId: string; sessionId: string; token: string; platform: DevicePlatform },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.deviceToken.deleteMany({
      where: { token: input.token, NOT: { sessionId: input.sessionId } },
    });
    await tx.deviceToken.upsert({
      where: { sessionId: input.sessionId },
      create: input,
      update: { token: input.token, platform: input.platform, userId: input.userId },
      select: { id: true },
    });
  }
}
