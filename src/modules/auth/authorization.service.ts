import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { AuthRepository, RoleAndPermissionCodes } from './auth.repository';

const CACHE = Symbol('authz-cache');
type CachedRequest = { [CACHE]?: Promise<RoleAndPermissionCodes> };

/**
 * Resolves what the authenticated caller may do, from the database (authoritative; role changes apply on the next
 * request). Memoised per request so stacked guards cost one lookup. Never cached across requests or in Redis.
 */
@Injectable()
export class AuthorizationService {
  constructor(private readonly repository: AuthRepository) {}

  forRequest(request: object, user: AuthenticatedUser): Promise<RoleAndPermissionCodes> {
    const cached = request as CachedRequest;
    cached[CACHE] ??= this.repository.getRoleAndPermissionCodes(user.userId);
    return cached[CACHE];
  }
}
