import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from '../../../common/decorators/auth.decorators';
import { AuthRepository } from '../auth.repository';
import { AuthorizationService } from '../authorization.service';
import { TokenService } from '../token.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { RolesGuard } from './roles.guard';

type Req = { headers: Record<string, string | undefined>; user?: unknown };

function context(request: Req): ExecutionContext {
  const handler = function handler() {};
  const klass = class Controller {};
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;
}

function reflectorFor(metadata: Record<string, unknown>): Reflector {
  return { getAllAndOverride: (key: string) => metadata[key] } as unknown as Reflector;
}

const activeSession = {
  sessionId: 's1',
  userId: 'u1',
  userType: 'ADMIN',
  userStatus: 'ACTIVE',
} as const;

describe('JwtAuthGuard', () => {
  const build = (opts: {
    metadata?: Record<string, unknown>;
    claims?: { sub: string; sid: string } | Error;
    session?: object | null;
  }) => {
    const tokens = {
      verifyAccessToken: jest.fn(() =>
        opts.claims instanceof Error
          ? Promise.reject(opts.claims)
          : Promise.resolve(opts.claims ?? { sub: 'u1', sid: 's1' }),
      ),
    } as unknown as TokenService;
    const repository = {
      findActiveSession: jest.fn(() =>
        Promise.resolve(opts.session === undefined ? activeSession : opts.session),
      ),
    } as unknown as AuthRepository;
    return {
      guard: new JwtAuthGuard(reflectorFor(opts.metadata ?? {}), tokens, repository),
      tokens,
      repository,
    };
  };

  it('lets @Public routes through without touching tokens or the database', async () => {
    const { guard, tokens, repository } = build({ metadata: { [IS_PUBLIC_KEY]: true } });
    await expect(guard.canActivate(context({ headers: {} }))).resolves.toBe(true);
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
    expect(repository.findActiveSession).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer a b'])(
    'rejects a missing/malformed Authorization header: %j',
    async (header) => {
      const { guard } = build({});
      await expect(
        guard.canActivate(context({ headers: { authorization: header } })),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    },
  );

  it('attaches the user for a valid token with an active session', async () => {
    const { guard } = build({});
    const request: Req = { headers: { authorization: 'Bearer good.token.value' } };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toEqual({ userId: 'u1', sessionId: 's1', type: 'ADMIN' });
  });

  it('rejects an invalid token', async () => {
    const { guard } = build({ claims: new Error('bad') });
    await expect(
      guard.canActivate(context({ headers: { authorization: 'Bearer x.y.z' } })),
    ).rejects.toThrow('bad');
  });

  it('rejects when the session is revoked/expired/unknown', async () => {
    const { guard } = build({ session: null });
    await expect(
      guard.canActivate(context({ headers: { authorization: 'Bearer x.y.z' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a suspended user even with a valid token and session', async () => {
    const { guard } = build({ session: { ...activeSession, userStatus: 'SUSPENDED' } });
    await expect(
      guard.canActivate(context({ headers: { authorization: 'Bearer x.y.z' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects when the session belongs to a different user than the token subject', async () => {
    const { guard } = build({ session: { ...activeSession, userId: 'someone-else' } });
    await expect(
      guard.canActivate(context({ headers: { authorization: 'Bearer x.y.z' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('RolesGuard / PermissionsGuard', () => {
  const user = { userId: 'u1', sessionId: 's1', type: 'ADMIN' };
  const authorizationWith = (roles: string[], permissions: string[]) => {
    const getRoleAndPermissionCodes = jest.fn(() => Promise.resolve({ roles, permissions }));
    return {
      service: new AuthorizationService({ getRoleAndPermissionCodes } as unknown as AuthRepository),
      getRoleAndPermissionCodes,
    };
  };

  it('allow routes that declare no requirement', async () => {
    const { service } = authorizationWith([], []);
    await expect(
      new RolesGuard(reflectorFor({}), service).canActivate(context({ headers: {} })),
    ).resolves.toBe(true);
    await expect(
      new PermissionsGuard(reflectorFor({}), service).canActivate(context({ headers: {} })),
    ).resolves.toBe(true);
  });

  it('RolesGuard: requires any listed role', async () => {
    const { service } = authorizationWith(['support'], []);
    const guard = new RolesGuard(reflectorFor({ [ROLES_KEY]: ['admin', 'support'] }), service);
    await expect(guard.canActivate(context({ headers: {}, user }))).resolves.toBe(true);
    const denied = new RolesGuard(reflectorFor({ [ROLES_KEY]: ['admin'] }), service);
    await expect(denied.canActivate(context({ headers: {}, user }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('PermissionsGuard: requires ALL listed permissions', async () => {
    const { service } = authorizationWith(['r'], ['a.read', 'a.write']);
    const ok = new PermissionsGuard(
      reflectorFor({ [PERMISSIONS_KEY]: ['a.read', 'a.write'] }),
      service,
    );
    await expect(ok.canActivate(context({ headers: {}, user }))).resolves.toBe(true);
    const partial = new PermissionsGuard(
      reflectorFor({ [PERMISSIONS_KEY]: ['a.read', 'b.write'] }),
      service,
    );
    await expect(partial.canActivate(context({ headers: {}, user }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('denies (does not crash) when no authenticated user is present', async () => {
    const { service } = authorizationWith([], ['x']);
    const guard = new PermissionsGuard(reflectorFor({ [PERMISSIONS_KEY]: ['x'] }), service);
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not reveal which permission was missing', async () => {
    const { service } = authorizationWith([], []);
    const guard = new PermissionsGuard(
      reflectorFor({ [PERMISSIONS_KEY]: ['payment.refund'] }),
      service,
    );
    const error = await guard.canActivate(context({ headers: {}, user })).catch((e: Error) => e);
    expect(
      JSON.stringify((error as unknown as { getResponse: () => unknown }).getResponse()),
    ).not.toContain('payment.refund');
  });

  it('AuthorizationService resolves once per request even when several guards ask', async () => {
    const { service, getRoleAndPermissionCodes } = authorizationWith(['r'], ['p']);
    const request = {};
    await service.forRequest(request, user as never);
    await service.forRequest(request, user as never);
    expect(getRoleAndPermissionCodes).toHaveBeenCalledTimes(1);
    await service.forRequest({}, user as never);
    expect(getRoleAndPermissionCodes).toHaveBeenCalledTimes(2);
  });
});
