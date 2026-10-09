import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SecurityEventService } from '../audit/security-events.service';
import { DomainException } from '../errors/domain.exception';
import { USER_TYPES_KEY, UserTypeGuard } from './user-type.guard';

const accessDenied = jest.fn(() => Promise.resolve());
const events = { accessDenied } as unknown as SecurityEventService;

function guardWith(allowed: string[] | undefined): UserTypeGuard {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) => (key === USER_TYPES_KEY ? allowed : undefined));
  return new UserTypeGuard(reflector, events);
}

function contextFor(user: { type: string } | undefined): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('UserTypeGuard', () => {
  beforeEach(() => accessDenied.mockClear());

  it('allows the listed user type', async () => {
    await expect(guardWith(['ADMIN']).canActivate(contextFor({ type: 'ADMIN' }))).resolves.toBe(
      true,
    );
    expect(accessDenied).not.toHaveBeenCalled();
  });

  it('allows any listed type when several are given', async () => {
    await expect(
      guardWith(['CUSTOMER', 'WORKER']).canActivate(contextFor({ type: 'WORKER' })),
    ).resolves.toBe(true);
  });

  it('answers 403 for another type without naming the accepted ones, and records the denial', async () => {
    const error: unknown = await guardWith(['ADMIN'])
      .canActivate(contextFor({ type: 'CUSTOMER' }))
      .catch((e: unknown) => e);
    expect(accessDenied).toHaveBeenCalledWith(expect.anything(), 'USER_TYPE');
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).getStatus()).toBe(403);
    expect((error as DomainException).message).not.toMatch(/ADMIN/);
  });

  it('answers 403 when no user is attached (guard misordering fails closed)', async () => {
    await expect(guardWith(['ADMIN']).canActivate(contextFor(undefined))).rejects.toBeInstanceOf(
      DomainException,
    );
  });

  it('does nothing when no types are declared', async () => {
    await expect(guardWith(undefined).canActivate(contextFor({ type: 'CUSTOMER' }))).resolves.toBe(
      true,
    );
  });
});
