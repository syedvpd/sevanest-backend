import { DomainException } from '../../common/errors/domain.exception';
import { AdminLoginThrottle } from './admin-login-throttle.service';
import { AuthErrorCode } from './auth.errors';
import { AuthService } from './auth.service';

/** Ordering rules of the admin login / password change: reserve an attempt BEFORE the slow hash, release only on success. */
describe('AuthService admin login throttling order', () => {
  const calls: string[] = [];
  const device = { deviceId: 'd', platform: 'web' } as never;
  const admin = {
    id: 'u1',
    type: 'ADMIN',
    status: 'ACTIVE',
    email: 'a@example.test',
    passwordHash: 'stored-hash',
  };

  let user: typeof admin | null;
  let passwordOk: boolean;
  let reserveError: Error | null;
  let service: AuthService;
  const hasher = {
    dummyHash: jest.fn(() => Promise.resolve('dummy')),
    verify: jest.fn(() => {
      calls.push('verify');
      return Promise.resolve(passwordOk);
    }),
  };
  const throttle = {
    reserve: jest.fn(() => {
      calls.push('reserve');
      return reserveError ? Promise.reject(reserveError) : Promise.resolve({ lastAllowed: false });
    }),
    release: jest.fn(() => {
      calls.push('release');
      return Promise.resolve();
    }),
  };
  const users = {
    findCredentialsByEmail: jest.fn(() => Promise.resolve(user)),
    findCredentialsById: jest.fn(() => Promise.resolve(user)),
    getAccess: jest.fn(() => Promise.resolve({ roles: [], permissions: [] })),
    assertPasswordMeetsPolicy: jest.fn(),
    hashPassword: jest.fn(() => Promise.resolve('new-hash')),
    setPasswordHash: jest.fn(),
  };
  const sessions = {
    startSession: jest.fn(() => Promise.resolve({ sessionId: 's1' })),
    revokeOthersWith: jest.fn(
      async (_u: string, _s: string, work: (tx: unknown) => Promise<void>) => {
        await work({});
        return 2;
      },
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };

  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
    user = { ...admin };
    passwordOk = true;
    reserveError = null;
    service = new AuthService(
      {} as never,
      sessions as never,
      users as never,
      hasher as never,
      throttle as never,
      audit as never,
    );
  });

  const login = () =>
    service.adminLogin({ email: 'a@example.test', password: 'pw' }, '203.0.113.9', device);
  const change = () =>
    service.changeAdminPassword(
      'u1',
      'cur',
      { currentPassword: 'old', newPassword: 'new-pass-123' },
      '203.0.113.9',
    );

  it('login: reserves before verifying, then releases on success', async () => {
    await login();
    expect(calls).toEqual(['reserve', 'verify', 'release']);
    expect(throttle.release).toHaveBeenCalledWith(
      AdminLoginThrottle.accountKey('a@example.test'),
      '203.0.113.9',
    );
  });

  it('login: a refused reservation never reaches the user lookup or the hash', async () => {
    reserveError = new DomainException(AuthErrorCode.ADMIN_LOGIN_LOCKED, 'locked', 429);
    await expect(login()).rejects.toMatchObject({ code: AuthErrorCode.ADMIN_LOGIN_LOCKED });
    expect(users.findCredentialsByEmail).not.toHaveBeenCalled();
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('login: a wrong password keeps the slot used (no release) and answers 401', async () => {
    passwordOk = false;
    await expect(login()).rejects.toMatchObject({ code: AuthErrorCode.INVALID_CREDENTIALS });
    expect(calls).toEqual(['reserve', 'verify']);
  });

  it('login: an unknown email behaves like a wrong password (same hash work, same answer, slot kept)', async () => {
    user = null;
    passwordOk = false;
    await expect(login()).rejects.toMatchObject({ code: AuthErrorCode.INVALID_CREDENTIALS });
    expect(hasher.dummyHash).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['reserve', 'verify']);
  });

  it('login: a suspended admin with the right password still uses up the attempt', async () => {
    user = { ...admin, status: 'SUSPENDED' };
    await expect(login()).rejects.toBeDefined();
    expect(throttle.release).not.toHaveBeenCalled();
  });

  it('password change: reserves before verifying and releases only after the current password is right', async () => {
    await change();
    expect(calls).toEqual(['reserve', 'verify', 'release']);
  });

  it('password change: a wrong current password keeps the slot used', async () => {
    passwordOk = false;
    await expect(change()).rejects.toMatchObject({
      code: AuthErrorCode.CURRENT_PASSWORD_INCORRECT,
    });
    expect(calls).toEqual(['reserve', 'verify']);
  });

  it('password change: a refused reservation never reaches the hash', async () => {
    reserveError = new DomainException(AuthErrorCode.ADMIN_LOGIN_LOCKED, 'locked', 429);
    await expect(change()).rejects.toMatchObject({ code: AuthErrorCode.ADMIN_LOGIN_LOCKED });
    expect(hasher.verify).not.toHaveBeenCalled();
  });
});
