import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser, PERMISSIONS_KEY } from '../../../common/decorators/auth.decorators';
import { SecurityEventService } from '../../../common/audit/security-events.service';
import { DomainException } from '../../../common/errors/domain.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { AuthorizationService } from '../authorization.service';

/**
 * Enforces @Permissions(...): caller must hold ALL listed permission codes via their roles. The response never says
 * which permission was missing. There is no built-in super-user bypass: any such policy would be an explicit decision.
 * Object-level access (e.g. "this booking belongs to this customer") is NOT covered here; services must enforce it.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly events: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
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
    const { permissions } = await this.authorization.forRequest(request, request.user);
    if (!required.every((code) => permissions.includes(code))) {
      await this.events.accessDenied(request, 'PERMISSION');
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
