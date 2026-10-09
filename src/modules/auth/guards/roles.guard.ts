import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser, ROLES_KEY } from '../../../common/decorators/auth.decorators';
import { SecurityEventService } from '../../../common/audit/security-events.service';
import { DomainException } from '../../../common/errors/domain.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { AuthorizationService } from '../authorization.service';

/** Enforces @Roles(...): caller must hold at least one of the listed role codes. No @Roles = no role requirement. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly events: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user) {
      throw this.forbidden();
    }
    const { roles } = await this.authorization.forRequest(request, request.user);
    if (!required.some((code) => roles.includes(code))) {
      await this.events.accessDenied(request, 'ROLE');
      throw this.forbidden();
    }
    return true;
  }

  private forbidden(): DomainException {
    return new DomainException(
      ErrorCode.FORBIDDEN,
      'You do not have permission to perform this action',
      HttpStatus.FORBIDDEN,
    );
  }
}
