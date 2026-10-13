import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception';
import { ErrorCode } from '../errors/error-codes';
import { isUniqueViolation } from '../errors/prisma-errors';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export const IDEMPOTENCY_TTL_HOURS = 24;
export const IDEMPOTENCY_KEY_FORMAT = /^[A-Za-z0-9_.:-]{8,100}$/;

export const IdempotencyErrorCode = {
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
} as const;

export type Claim =
  | { kind: 'CLAIMED'; id: string }
  | { kind: 'REPLAY'; statusCode: number; body: unknown }
  | { kind: 'IN_PROGRESS' }
  | { kind: 'REUSED' };

/**
 * Generic Idempotency-Key support for unsafe endpoints. The first request with a key claims it (a unique row per user and key, so two
 * concurrent requests cannot both run); when it finishes its response is stored and a repeat with the same request gets that response
 * back instead of running again. The same key with a different request is refused, so a key can never be "reused" for something else.
 * A request that fails leaves nothing behind, so the client may retry with the same key. Keys last 24 hours.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(
    userId: string,
    key: string,
    request: { method: string; path: string; hash: string },
  ): Promise<Claim> {
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3_600_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await this.prisma.idempotencyKey.create({
          data: {
            userId,
            key,
            method: request.method,
            path: request.path,
            requestHash: request.hash,
            expiresAt,
          },
          select: { id: true },
        });
        return { kind: 'CLAIMED', id: row.id };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { userId_key: { userId, key } },
      });
      if (!existing) continue; // released between the insert and the read: claim again
      if (existing.expiresAt.getTime() <= Date.now()) {
        await this.prisma.idempotencyKey.deleteMany({ where: { id: existing.id } });
        continue;
      }
      if (existing.requestHash !== request.hash) return { kind: 'REUSED' };
      if (!existing.done) return { kind: 'IN_PROGRESS' };
      return {
        kind: 'REPLAY',
        statusCode: existing.statusCode ?? 200,
        body: existing.responseBody,
      };
    }
    return { kind: 'IN_PROGRESS' };
  }

  async complete(id: string, statusCode: number, body: unknown): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { id },
      data: { done: true, statusCode, responseBody: (body ?? null) as never },
    });
  }

  /** The request failed: forget the claim so the client can retry with the same key. */
  async release(id: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({ where: { id } });
  }

  async purgeExpired(limit = 1000): Promise<number> {
    const rows = await this.prisma.idempotencyKey.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true },
      take: limit,
    });
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    return count;
  }

  static invalidKey(): DomainException {
    return new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field: 'Idempotency-Key', messages: ['must be 8-100 letters, digits or _ . : -'] }],
    );
  }
}
