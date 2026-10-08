import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

const SECRET = 'unit-test-secret-unit-test-secret-0123';

function service(secret = SECRET, expiresIn: number | string = 900) {
  return new TokenService(
    new JwtService({ secret, signOptions: { expiresIn: expiresIn as number } }),
  );
}

describe('TokenService', () => {
  const claims = { sub: 'user-1', sid: 'session-1' };

  it('round-trips access-token claims', async () => {
    const tokens = service();
    const token = await tokens.signAccessToken(claims);
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual(claims);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await service('another-secret-another-secret-012345').signAccessToken(claims);
    await expect(service().verifyAccessToken(token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects an expired token', async () => {
    const tokens = service(SECRET, -10);
    const token = await tokens.signAccessToken(claims);
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects tampered and garbage tokens', async () => {
    const tokens = service();
    const token = await tokens.signAccessToken(claims);
    await expect(tokens.verifyAccessToken(token.slice(0, -2) + 'xx')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(tokens.verifyAccessToken('not-a-jwt')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, iss: 'sevanest-api', aud: 'sevanest-clients' })}.`;
    await expect(service().verifyAccessToken(none)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a validly-signed token with a different audience or missing claims', async () => {
    const jwt = new JwtService({ secret: SECRET });
    const wrongAud = await jwt.signAsync(
      { ...claims },
      { issuer: 'sevanest-api', audience: 'someone-else', expiresIn: 60 },
    );
    const missing = await jwt.signAsync(
      { sub: 'u' },
      { issuer: 'sevanest-api', audience: 'sevanest-clients', expiresIn: 60 },
    );
    await expect(service().verifyAccessToken(wrongAud)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(service().verifyAccessToken(missing)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('generates unique, high-entropy refresh tokens and hashes them deterministically', () => {
    const tokens = service();
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(60);
    expect(tokens.hashRefreshToken(a)).toBe(tokens.hashRefreshToken(a));
    expect(tokens.hashRefreshToken(a)).not.toBe(tokens.hashRefreshToken(b));
    expect(tokens.hashRefreshToken(a)).not.toContain(a);
    expect(tokens.hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
