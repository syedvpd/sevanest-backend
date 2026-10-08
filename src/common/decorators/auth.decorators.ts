import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserType } from '../../generated/prisma/client';

/** Identity attached to the request by JwtAuthGuard after the token AND the server-side session check pass. */
export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
  type: UserType;
}

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';
export const PERMISSIONS_KEY = 'auth:permissions';

/** Opt a route OUT of authentication. Every route is authenticated by default (default-deny). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Require the caller to hold at least one of the given role codes (roles are data, not hard-coded policy). */
export const Roles = (...roleCodes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roleCodes);

/** Require the caller to hold ALL of the given permission codes, e.g. @Permissions('booking.approve'). */
export const Permissions = (...permissionCodes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissionCodes);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    return request.user;
  },
);
