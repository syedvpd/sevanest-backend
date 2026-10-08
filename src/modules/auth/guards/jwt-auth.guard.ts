import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthenticatedUser, IS_PUBLIC_KEY } from '../../../common/decorators/auth.decorators';
import { DomainException } from '../../../common/errors/domain.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { AuthRepository } from '../auth.repository';
import { TokenService } from '../token.service';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Global authentication (default-deny). A request is authenticated only if the bearer token verifies AND its
 * server-side session is still active AND the user is ACTIVE (suspended users cannot act; FRD FM-01, FR-SEC-007).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly repository: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (!match) {
      throw this.unauthenticated('Authentication is required');
    }

    const claims = await this.tokens.verifyAccessToken(match[1]);
    const session = await this.repository.findActiveSession(claims.sid, new Date());
    if (!session || session.userId !== claims.sub || session.userStatus !== 'ACTIVE') {
      throw this.unauthenticated('Session is not active');
    }

    request.user = { userId: session.userId, sessionId: session.sessionId, type: session.userType };
    return true;
  }

  private unauthenticated(message: string): DomainException {
    return new DomainException(ErrorCode.UNAUTHENTICATED, message, HttpStatus.UNAUTHORIZED);
  }
}
