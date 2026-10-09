import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../decorators/auth.decorators';
import { AuditService } from './audit.service';

export type DenialReason = 'USER_TYPE' | 'ROLE' | 'PERMISSION';

interface DeniedRequest {
  method?: string;
  /** Express route pattern, e.g. /api/v1/admin/users/:userId/status (never the raw URL). */
  route?: { path?: string };
  user?: AuthenticatedUser;
}

/**
 * Security events that are not business state changes (FRD FM-14: "Unauthorized access attempt: access denied and logged").
 * An authenticated caller refused by a role, user-type or permission check leaves one append-only audit record with who, which
 * route pattern, the method and which kind of check refused. The record holds no body, query string, path parameter or
 * token (the route PATTERN is stored, not the URL), so it cannot carry personal data. Writing it never changes the answer:
 * the caller still gets the same 403, even if the audit write fails.
 */
@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(private readonly audit: AuditService) {}

  async accessDenied(request: DeniedRequest, reason: DenialReason): Promise<void> {
    try {
      await this.audit.record({
        action: 'security.access_denied',
        entityType: 'route',
        actorId: request.user?.userId ?? null,
        metadata: {
          method: request.method ?? null,
          route: request.route?.path ?? null,
          reason,
          userType: request.user?.type ?? null,
        },
      });
    } catch (error) {
      this.logger.error({
        msg: 'Could not record an access-denied event',
        err: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
