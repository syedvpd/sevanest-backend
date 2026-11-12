import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import {
  ADMIN_AUTH_THROTTLER_NAME,
  AdminAuthThrottle,
  AppThrottlerGuard,
  isAdminAuthThrottleRoute,
} from './app-throttler.guard';

class DemoController {
  @AdminAuthThrottle()
  adminLogin(): void {}

  normalRoute(): void {}
}

class ExposedAppThrottlerGuard extends AppThrottlerGuard {
  writeHeader(res: Record<string, unknown>, name: string, value: string | number): void {
    this.setResponseHeader(res, name, value);
  }
}

function contextFor(methodName: keyof DemoController): ExecutionContext {
  const proto = DemoController.prototype;
  const handler = proto[methodName];
  return {
    getHandler: () => handler,
    getClass: () => DemoController,
  } as unknown as ExecutionContext;
}

describe('AppThrottlerGuard & AdminAuthThrottle', () => {
  it('marks decorated routes for the adminAuth bucket and skips the default bucket', () => {
    expect(isAdminAuthThrottleRoute(contextFor('adminLogin'))).toBe(true);
    expect(isAdminAuthThrottleRoute(contextFor('normalRoute'))).toBe(false);

    const reflector = new Reflector();
    const skippedDefault = reflector.get<boolean>(
      `${THROTTLER_SKIP}default`,
      DemoController.prototype.adminLogin,
    );
    expect(skippedDefault).toBe(true);
  });

  it('normalizes named adminAuth rate-limit and Retry-After headers into standard headers', () => {
    const guard = new ExposedAppThrottlerGuard(
      { throttlers: [] },
      {} as ThrottlerStorage,
      new Reflector(),
    );
    const written: Array<[string, string | number]> = [];
    const res = {
      header: (name: string, value: string | number) => {
        written.push([name, value]);
      },
    };

    guard.writeHeader(res, `Retry-After-${ADMIN_AUTH_THROTTLER_NAME}`, 0);
    guard.writeHeader(res, `Retry-After-${ADMIN_AUTH_THROTTLER_NAME}`, 42);
    guard.writeHeader(res, `X-RateLimit-Limit-${ADMIN_AUTH_THROTTLER_NAME}`, 20);
    guard.writeHeader(res, `X-RateLimit-Remaining-${ADMIN_AUTH_THROTTLER_NAME}`, 19);
    guard.writeHeader(res, `X-RateLimit-Reset-${ADMIN_AUTH_THROTTLER_NAME}`, 60);

    expect(written).toEqual([
      ['Retry-After', 1],
      ['Retry-After', 42],
      ['X-RateLimit-Limit', 20],
      ['X-RateLimit-Remaining', 19],
      ['X-RateLimit-Reset', 60],
    ]);
  });
});

