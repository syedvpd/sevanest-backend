import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { DomainException } from '../errors/domain.exception';

export const PRECONDITION_REQUIRED = 'PRECONDITION_REQUIRED';
const REQUIRE_IF_MATCH = 'requireIfMatch';

/**
 * DEC-16: an admin edit of an existing record must say which version it edits. Without an `If-Match` header the request is refused with
 * 428 PRECONDITION_REQUIRED (when ADMIN_IF_MATCH_REQUIRED is on); a stale version is 412 STALE_VERSION (assertIfMatch, under the row lock).
 * `If-Match: *` is the explicit "I do not care" and, for creating a record that does not exist yet, the only value that fits.
 * Runs after authentication and permission checks, so an anonymous caller still gets 401/403 first.
 */
@Injectable()
export class IfMatchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.reflector.get<boolean>(REQUIRE_IF_MATCH, context.getHandler())) return true;
    if (!this.config.adminIfMatchRequired) return true;
    const header = context.switchToHttp().getRequest<Request>().headers['if-match'];
    if (typeof header === 'string' && header.trim() !== '') return true;
    throw new DomainException(
      PRECONDITION_REQUIRED,
      'Send the If-Match header with the ETag you loaded (or * to overwrite)',
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
}

export const RequireIfMatch = (): MethodDecorator =>
  applyDecorators(SetMetadata(REQUIRE_IF_MATCH, true), UseGuards(IfMatchGuard));
