import { applyDecorators, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  SkipThrottle,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';

export const ADMIN_AUTH_THROTTLER_NAME = 'adminAuth';
export const ADMIN_AUTH_THROTTLE_KEY = 'throttle:adminAuthRoute';

const ADMIN_AUTH_SUFFIX = `-${ADMIN_AUTH_THROTTLER_NAME}`;

/**
 * Assigns a controller or handler to the isolated Admin Portal authentication rate-limit bucket
 * and skips the global default bucket so admin auth traffic does not share quotas with general routes.
 */
export function AdminAuthThrottle(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(ADMIN_AUTH_THROTTLE_KEY, true),
    SkipThrottle({ default: true }),
  );
}

/** True when the current handler or controller opts into the Admin Portal auth rate-limit bucket. */
export function isAdminAuthThrottleRoute(context: ExecutionContext): boolean {
  return Boolean(
    Reflect.getMetadata(ADMIN_AUTH_THROTTLE_KEY, context.getHandler()) ??
    Reflect.getMetadata(ADMIN_AUTH_THROTTLE_KEY, context.getClass()),
  );
}

/**
 * Extends Nest's ThrottlerGuard to normalize named-bucket response headers (such as Retry-After-adminAuth)
 * into standard HTTP headers (Retry-After, X-RateLimit-*) with positive integer Retry-After values.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected override setResponseHeader(
    res: Record<string, unknown>,
    name: string,
    value: string | number,
  ): void {
    const normalizedName = name.endsWith(ADMIN_AUTH_SUFFIX)
      ? name.slice(0, -ADMIN_AUTH_SUFFIX.length)
      : name;
    const normalizedValue =
      normalizedName === 'Retry-After' ? Math.max(1, Math.ceil(Number(value) || 0)) : value;
    super.setResponseHeader(res, normalizedName, normalizedValue);
  }
}
