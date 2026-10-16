import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/cache/redis.service';
import type { AuthenticatedUser } from '../decorators/auth.decorators';
import { AuditService } from './audit.service';

export type DenialReason = 'USER_TYPE' | 'ROLE' | 'PERMISSION';

interface DeniedRequest {
  method?: string;
  /** Express route pattern, e.g. /api/v1/admin/users/:userId/status (never the raw URL). */
  route?: { path?: string };
  user?: AuthenticatedUser;
}

const WINDOW_MS = 60_000;
const PENDING = 'sec:denied:pending';

interface Suppressed {
  actorId: string | null;
  method: string | null;
  route: string | null;
  reason: DenialReason;
  userType: string | null;
  windowStart: number;
}

/**
 * Security events that are not business state changes (FRD FM-14: "Unauthorized access attempt: access denied and logged").
 * An authenticated caller refused by a role, user-type or permission check leaves an append-only audit record with who, which
 * route pattern, the method and which kind of check refused. The record holds no body, query string, path parameter or
 * token (the route PATTERN is stored, not the URL), so it cannot carry personal data. Writing it never changes the answer:
 * the caller still gets the same 403, even if the audit write fails.
 *
 * Collapsing (WP-13): the first refusal of the same caller on the same route and check in a minute is written in full; the repeats in that
 * minute are only counted in Redis and the count is written once, as one `security.access_denied_repeated` row, when the minute is over
 * (`flushSuppressed`). A hammered endpoint therefore costs two rows per minute instead of thousands, and no refusal is lost. The audit
 * table is append-only, so a row can never be updated: that is why the count is a second row. If Redis is down nothing is suppressed.
 */
@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async accessDenied(request: DeniedRequest, reason: DenialReason): Promise<void> {
    try {
      const event: Suppressed = {
        actorId: request.user?.userId ?? null,
        method: request.method ?? null,
        route: request.route?.path ?? null,
        reason,
        userType: request.user?.type ?? null,
        windowStart: Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS,
      };
      if (await this.suppressRepeat(event)) return;
      await this.audit.record({
        action: 'security.access_denied',
        entityType: 'route',
        actorId: event.actorId,
        metadata: {
          method: event.method,
          route: event.route,
          reason,
          userType: event.userType,
        },
      });
    } catch (error) {
      this.logger.error({
        msg: 'Could not record an access-denied event',
        err: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /** True when this refusal repeats one already written in the current minute (it is counted instead). Redis problems mean "write it". */
  private async suppressRepeat(event: Suppressed): Promise<boolean> {
    try {
      await this.redis.ensureConnected();
      const id = createHash('sha1')
        .update(
          [event.actorId, event.method, event.route, event.reason, event.windowStart].join('|'),
        )
        .digest('hex');
      const first = await this.redis.client.set(`sec:denied:${id}`, '1', 'EX', 180, 'NX');
      if (first === 'OK') return false;
      await this.redis.client
        .multi()
        .hincrby(`sec:denied:n:${id}`, 'count', 1)
        .hsetnx(`sec:denied:n:${id}`, 'event', JSON.stringify(event))
        .expire(`sec:denied:n:${id}`, 900)
        .zadd(PENDING, 'NX', event.windowStart + WINDOW_MS, id)
        .exec();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writes the counts of the minutes that are over, one row each, and forgets them. Safe to run in several workers at once (ZREM decides
   * who owns an entry). Returns how many summary rows were written.
   */
  async flushSuppressed(now = Date.now()): Promise<number> {
    let written = 0;
    try {
      await this.redis.ensureConnected();
      const due = await this.redis.client.zrangebyscore(PENDING, '-inf', now, 'LIMIT', 0, 200);
      for (const id of due) {
        if ((await this.redis.client.zrem(PENDING, id)) !== 1) continue; // another worker took it
        const stored = await this.redis.client.hgetall(`sec:denied:n:${id}`);
        await this.redis.client.del(`sec:denied:n:${id}`);
        if (!stored.event || !stored.count) continue;
        const event = JSON.parse(stored.event) as Suppressed;
        await this.audit.record({
          action: 'security.access_denied_repeated',
          entityType: 'route',
          actorId: event.actorId,
          metadata: {
            method: event.method,
            route: event.route,
            reason: event.reason,
            userType: event.userType,
            suppressed: Number(stored.count),
            windowStart: new Date(event.windowStart).toISOString(),
          },
        });
        written++;
      }
    } catch (error) {
      this.logger.warn(
        `Suppressed access-denied counts could not be flushed: ${(error as Error).message}`,
      );
    }
    return written;
  }
}
