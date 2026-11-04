import { SessionRepository } from './session.repository';
import type { PrismaService } from '../../infrastructure/database/prisma.service';

describe('SessionRepository.listDeviceTokens', () => {
  let repository: SessionRepository;
  let mockPrisma: {
    deviceToken: {
      findMany: jest.Mock;
    };
  };

  beforeEach(() => {
    mockPrisma = {
      deviceToken: {
        findMany: jest.fn(),
      },
    };
    repository = new SessionRepository(mockPrisma as unknown as PrismaService);
  });

  it('queries device tokens for active sessions with revokedAt=null and expiresAt > now', async () => {
    const fixedNow = new Date('2026-11-04T12:00:00Z');
    mockPrisma.deviceToken.findMany.mockResolvedValueOnce([
      { token: 'token-active-1' },
      { token: 'token-active-2' },
    ]);

    const result = await repository.listDeviceTokens('user-uuid-1', fixedNow);

    expect(result).toEqual(['token-active-1', 'token-active-2']);
    expect(mockPrisma.deviceToken.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-uuid-1',
        session: {
          revokedAt: null,
          expiresAt: { gt: fixedNow },
        },
      },
      select: { token: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('returns empty array when user has no active tokens', async () => {
    mockPrisma.deviceToken.findMany.mockResolvedValueOnce([]);

    const result = await repository.listDeviceTokens('user-no-tokens');

    expect(result).toEqual([]);
    expect(mockPrisma.deviceToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-no-tokens',
          session: expect.objectContaining({
            revokedAt: null,
          }),
        }),
      }),
    );
  });
});
