import { AuthErrorCode } from './auth.errors';
import { SessionService } from './session.service';

describe('SessionService.refresh', () => {
  const userId = 'user-1';
  const sessionId = 'session-1';

  let rotateMock: jest.Mock;
  let findActiveByPreviousHashMock: jest.Mock;
  let revokeMock: jest.Mock;
  let transactionMock: jest.Mock;
  let hashRefreshTokenMock: jest.Mock;
  let generateRefreshTokenMock: jest.Mock;
  let signAccessTokenMock: jest.Mock;
  let findByIdMock: jest.Mock;
  let getAccessMock: jest.Mock;
  let onStatusChangedMock: jest.Mock;
  let auditRecordMock: jest.Mock;
  let service: SessionService;

  beforeEach(() => {
    rotateMock = jest.fn();
    findActiveByPreviousHashMock = jest.fn();
    revokeMock = jest.fn().mockResolvedValue(true);
    transactionMock = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));

    hashRefreshTokenMock = jest.fn((t: string) => `hash-${t}`);
    generateRefreshTokenMock = jest.fn(() => 'new-refresh-token');
    signAccessTokenMock = jest.fn().mockResolvedValue('new-access-token');

    findByIdMock = jest.fn().mockResolvedValue({ id: userId, status: 'ACTIVE', type: 'ADMIN' });
    getAccessMock = jest.fn().mockResolvedValue({ roles: ['SUPER_ADMIN'], permissions: ['*'] });
    onStatusChangedMock = jest.fn();
    auditRecordMock = jest.fn().mockResolvedValue(undefined);

    const repository = {
      rotate: rotateMock,
      findActiveByPreviousHash: findActiveByPreviousHashMock,
      revoke: revokeMock,
      transaction: transactionMock,
    };

    const tokens = {
      hashRefreshToken: hashRefreshTokenMock,
      generateRefreshToken: generateRefreshTokenMock,
      signAccessToken: signAccessTokenMock,
    };

    const users = {
      findById: findByIdMock,
      getAccess: getAccessMock,
    };

    const userEvents = {
      onStatusChanged: onStatusChangedMock,
    };

    const audit = {
      record: auditRecordMock,
    };

    const config = {
      refreshReuseGraceSeconds: 10,
      jwtAccessTtlSeconds: 900,
    };

    service = new SessionService(
      repository as never,
      tokens as never,
      users as never,
      userEvents as never,
      audit as never,
      config as never,
    );
  });

  it('rotates the refresh token and issues a new pair when rotate succeeds', async () => {
    rotateMock.mockResolvedValueOnce({ sessionId, userId });

    const result = await service.refresh('initial-token', 'device-1');

    expect(result).toMatchObject({
      userId,
      sessionId,
      refreshToken: 'new-refresh-token',
      accessToken: 'new-access-token',
      userType: 'ADMIN',
    });
    expect(rotateMock).toHaveBeenCalledWith(
      'hash-initial-token',
      'hash-new-refresh-token',
      expect.any(Date),
    );
    expect(revokeMock).not.toHaveBeenCalled();
  });

  describe('replay grace period (DEC-14 & web session concurrency)', () => {
    it('answers 409 REFRESH_IN_PROGRESS and preserves session for legitimate mobile retry with matching deviceId within grace', async () => {
      rotateMock.mockResolvedValueOnce(null);
      findActiveByPreviousHashMock.mockResolvedValueOnce({
        id: sessionId,
        userId,
        deviceId: 'device-1',
        rotatedAt: new Date(Date.now() - 2000), // 2 seconds ago (within 10s grace)
      });

      await expect(service.refresh('initial-token', 'device-1')).rejects.toMatchObject({
        code: AuthErrorCode.REFRESH_IN_PROGRESS,
        status: 409,
      });

      expect(revokeMock).not.toHaveBeenCalled();
      expect(auditRecordMock).not.toHaveBeenCalled();
    });

    it('answers 409 REFRESH_IN_PROGRESS and preserves session for legitimate browser web retry (unbound device) within grace', async () => {
      rotateMock.mockResolvedValueOnce(null);
      findActiveByPreviousHashMock.mockResolvedValueOnce({
        id: sessionId,
        userId,
        deviceId: null, // Web session created without deviceId
        rotatedAt: new Date(Date.now() - 500), // 500ms ago (concurrent browser queries)
      });

      // Browser sends no deviceId
      await expect(service.refresh('initial-token', undefined)).rejects.toMatchObject({
        code: AuthErrorCode.REFRESH_IN_PROGRESS,
        status: 409,
      });

      expect(revokeMock).not.toHaveBeenCalled();
      expect(auditRecordMock).not.toHaveBeenCalled();
    });

    it('revokes session and logs audit when replay occurs outside the grace window', async () => {
      rotateMock.mockResolvedValueOnce(null);
      findActiveByPreviousHashMock.mockResolvedValueOnce({
        id: sessionId,
        userId,
        deviceId: 'device-1',
        rotatedAt: new Date(Date.now() - 25000), // 25s ago (> 10s grace)
      });

      await expect(service.refresh('initial-token', 'device-1')).rejects.toMatchObject({
        code: AuthErrorCode.REFRESH_TOKEN_INVALID,
        status: 401,
      });

      expect(revokeMock).toHaveBeenCalledWith({ id: sessionId }, expect.anything());
      expect(auditRecordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.refresh_token_reuse',
          entityId: sessionId,
          actorId: userId,
          metadata: { outcome: 'session_revoked' },
        }),
        expect.anything(),
      );
    });

    it('revokes session when mobile session (with deviceId) is replayed without a deviceId', async () => {
      rotateMock.mockResolvedValueOnce(null);
      findActiveByPreviousHashMock.mockResolvedValueOnce({
        id: sessionId,
        userId,
        deviceId: 'device-1',
        rotatedAt: new Date(Date.now() - 1000), // Within 10s, but missing deviceId
      });

      await expect(service.refresh('initial-token', undefined)).rejects.toMatchObject({
        code: AuthErrorCode.REFRESH_TOKEN_INVALID,
        status: 401,
      });

      expect(revokeMock).toHaveBeenCalledWith({ id: sessionId }, expect.anything());
      expect(auditRecordMock).toHaveBeenCalled();
    });

    it('revokes session when mobile session is replayed from a different deviceId', async () => {
      rotateMock.mockResolvedValueOnce(null);
      findActiveByPreviousHashMock.mockResolvedValueOnce({
        id: sessionId,
        userId,
        deviceId: 'device-1',
        rotatedAt: new Date(Date.now() - 1000),
      });

      await expect(service.refresh('initial-token', 'device-attacker')).rejects.toMatchObject({
        code: AuthErrorCode.REFRESH_TOKEN_INVALID,
        status: 401,
      });

      expect(revokeMock).toHaveBeenCalledWith({ id: sessionId }, expect.anything());
      expect(auditRecordMock).toHaveBeenCalled();
    });

    it('revokes session when unbound web session is replayed with an unexpected deviceId', async () => {
      rotateMock.mockResolvedValueOnce(null);
      findActiveByPreviousHashMock.mockResolvedValueOnce({
        id: sessionId,
        userId,
        deviceId: null,
        rotatedAt: new Date(Date.now() - 1000),
      });

      await expect(service.refresh('initial-token', 'spoofed-device')).rejects.toMatchObject({
        code: AuthErrorCode.REFRESH_TOKEN_INVALID,
        status: 401,
      });

      expect(revokeMock).toHaveBeenCalledWith({ id: sessionId }, expect.anything());
      expect(auditRecordMock).toHaveBeenCalled();
    });
  });

  it('rejects with 401 when token is completely unknown', async () => {
    rotateMock.mockResolvedValueOnce(null);
    findActiveByPreviousHashMock.mockResolvedValueOnce(null);

    await expect(service.refresh('unknown-token')).rejects.toMatchObject({
      code: AuthErrorCode.REFRESH_TOKEN_INVALID,
      status: 401,
    });

    expect(revokeMock).not.toHaveBeenCalled();
    expect(auditRecordMock).not.toHaveBeenCalled();
  });

  it('revokes session and rejects with 403 when user is suspended at refresh time', async () => {
    rotateMock.mockResolvedValueOnce({ sessionId, userId });
    findByIdMock.mockResolvedValueOnce({ id: userId, status: 'SUSPENDED', type: 'ADMIN' });

    await expect(service.refresh('initial-token')).rejects.toMatchObject({
      code: AuthErrorCode.ACCOUNT_SUSPENDED,
      status: 403,
    });

    expect(revokeMock).toHaveBeenCalledWith({ id: sessionId }, expect.anything());
  });
});
