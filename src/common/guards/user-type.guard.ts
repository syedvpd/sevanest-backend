import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserType } from '../../generated/prisma/client';
import { SecurityEventService } from '../audit/security-events.service';
import type { AuthenticatedUser } from '../decorators/auth.decorators';
import { DomainException } from '../errors/domain.exception';
import { ErrorCode } from '../errors/error-codes';

export const USER_TYPES_KEY = 'auth:userTypes';

/** Enforces @RequireUserType(...). Answers 403 without revealing which types would be accepted. */
@Injectable()
export class UserTypeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly events: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = this.reflector.getAllAndOverride<UserType[] | undefined>(USER_TYPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed || allowed.length === 0) {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser; method?: string; route?: { path?: string } }>();
    if (!request.user || !allowed.includes(request.user.type)) {
      await this.events.accessDenied(request, 'USER_TYPE');
      throw new DomainException(
        ErrorCode.FORBIDDEN,
        'You do not have permission to perform this action',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
