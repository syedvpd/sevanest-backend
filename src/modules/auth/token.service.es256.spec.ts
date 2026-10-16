import { generateKeyPairSync } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { parseJwtKeys } from '../../config/jwt-keys';
import { TokenService } from './token.service';

const SECRET = 'unit-test-secret-unit-test-secret-0123';
const claims = { sub: 'user-1', sid: 'session-1' };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

function pair(curve = 'P-256') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function tokenService(keys: string | null, legacy = false) {
  const set = keys ? parseJwtKeys(keys) : null;
  return new TokenService(new JwtService({ signOptions: { expiresIn: 900 } }), {
    jwtAccessSecret: SECRET,
    jwtKeySet: set,
    jwtLegacyHs256Accepted: legacy || !set,
  });
}

describe('TokenService ES256 (DEC-19)', () => {
  const a = pair();
  const b = pair();
  const keysA = JSON.stringify([{ kid: 'k-a', privateKey: a.privateKey }]);
  const rotated = JSON.stringify([
    { kid: 'k-b', privateKey: b.privateKey },
    { kid: 'k-a', publicKey: a.publicKey },
  ]);
  const unauthenticated = { code: 'UNAUTHENTICATED' };

  it('signs ES256 with the kid and round-trips the claims', async () => {
    const svc = tokenService(keysA);
    const token = await svc.signAccessToken(claims);
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toMatchObject({
      alg: 'ES256',
      kid: 'k-a',
    });
    await expect(svc.verifyAccessToken(token)).resolves.toEqual(claims);
  });

  it('still verifies a token from the previous key during rotation, and refuses it once that key is removed', async () => {
    const old = await tokenService(keysA).signAccessToken(claims);
    await expect(tokenService(rotated).verifyAccessToken(old)).resolves.toEqual(claims);
    const fresh = await tokenService(rotated).signAccessToken(claims);
    expect(JSON.parse(Buffer.from(fresh.split('.')[0], 'base64url').toString()).kid).toBe('k-b');
    const onlyB = JSON.stringify([{ kid: 'k-b', privateKey: b.privateKey }]);
    await expect(tokenService(onlyB).verifyAccessToken(old)).rejects.toMatchObject(unauthenticated);
  });

  it('refuses an unknown kid, a missing kid and a token signed by another key under a known kid', async () => {
    const other = pair();
    const stranger = await tokenService(
      JSON.stringify([{ kid: 'k-x', privateKey: other.privateKey }]),
    ).signAccessToken(claims);
    await expect(tokenService(keysA).verifyAccessToken(stranger)).rejects.toMatchObject(
      unauthenticated,
    );
    const impostor = await tokenService(
      JSON.stringify([{ kid: 'k-a', privateKey: other.privateKey }]),
    ).signAccessToken(claims);
    await expect(tokenService(keysA).verifyAccessToken(impostor)).rejects.toMatchObject(
      unauthenticated,
    );
    const noKid = await new JwtService().signAsync(claims, {
      algorithm: 'ES256',
      secret: a.privateKey,
      issuer: 'sevanest-api',
      audience: 'sevanest-clients',
      expiresIn: 60,
    });
    await expect(tokenService(keysA).verifyAccessToken(noKid)).rejects.toMatchObject(
      unauthenticated,
    );
  });

  it('refuses expired tokens and a wrong audience or issuer', async () => {
    const jwt = new JwtService();
    const sign = (over: object) =>
      jwt.signAsync(claims, {
        algorithm: 'ES256',
        keyid: 'k-a',
        secret: a.privateKey,
        issuer: 'sevanest-api',
        audience: 'sevanest-clients',
        expiresIn: 60,
        ...over,
      });
    const svc = tokenService(keysA);
    await expect(svc.verifyAccessToken(await sign({ expiresIn: -10 }))).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(svc.verifyAccessToken(await sign({ audience: 'x' }))).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(svc.verifyAccessToken(await sign({ issuer: 'x' }))).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(svc.verifyAccessToken(await sign({}))).resolves.toEqual(claims);
  });

  it('refuses alg=none', async () => {
    const none = `${b64({ alg: 'none', typ: 'JWT', kid: 'k-a' })}.${b64({ ...claims, iss: 'sevanest-api', aud: 'sevanest-clients' })}.`;
    await expect(tokenService(keysA).verifyAccessToken(none)).rejects.toMatchObject(
      unauthenticated,
    );
  });

  it('refuses the HS256/ES256 confusion attack (HS256 token whose "secret" is the public key)', async () => {
    const forged = await new JwtService().signAsync(claims, {
      algorithm: 'HS256',
      secret: a.publicKey,
      keyid: 'k-a',
      issuer: 'sevanest-api',
      audience: 'sevanest-clients',
      expiresIn: 60,
    });
    // Even while legacy HS256 is accepted the public key is never used as an HMAC secret.
    await expect(tokenService(keysA, true).verifyAccessToken(forged)).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(tokenService(keysA, false).verifyAccessToken(forged)).rejects.toMatchObject(
      unauthenticated,
    );
  });

  it('accepts legacy HS256 tokens only inside the migration window', async () => {
    const legacy = await tokenService(null).signAccessToken(claims);
    await expect(tokenService(keysA, true).verifyAccessToken(legacy)).resolves.toEqual(claims);
    await expect(tokenService(keysA, false).verifyAccessToken(legacy)).rejects.toMatchObject(
      unauthenticated,
    );
  });

  it('an ES256 token is refused by a service that has no key set', async () => {
    const token = await tokenService(keysA).signAccessToken(claims);
    await expect(tokenService(null).verifyAccessToken(token)).rejects.toMatchObject(
      unauthenticated,
    );
  });
});

describe('parseJwtKeys', () => {
  const a = pair();

  it('rejects malformed sets without echoing key material', () => {
    expect(() => parseJwtKeys('nope')).toThrow('JSON array');
    expect(() => parseJwtKeys('[]')).toThrow('1 to');
    expect(() => parseJwtKeys(JSON.stringify([{ privateKey: a.privateKey }]))).toThrow('kid');
    expect(() =>
      parseJwtKeys(
        JSON.stringify([
          { kid: 'x', privateKey: a.privateKey },
          { kid: 'x', publicKey: a.publicKey },
        ]),
      ),
    ).toThrow('duplicate');
    expect(() => parseJwtKeys(JSON.stringify([{ kid: 'x', publicKey: a.publicKey }]))).toThrow(
      'first key must have a privateKey',
    );
    expect(() => parseJwtKeys(JSON.stringify([{ kid: 'x', privateKey: 'garbage' }]))).toThrow(
      'unreadable',
    );
    const wrongCurve = pair('P-384');
    expect(() =>
      parseJwtKeys(JSON.stringify([{ kid: 'x', privateKey: wrongCurve.privateKey }])),
    ).toThrow('P-256');
    try {
      parseJwtKeys(JSON.stringify([{ kid: 'x', privateKey: 'garbage-secret-material' }]));
    } catch (error) {
      expect((error as Error).message).not.toContain('garbage-secret-material');
    }
  });

  it('derives the public key from a private key', () => {
    const set = parseJwtKeys(JSON.stringify([{ kid: 'x', privateKey: a.privateKey }]));
    expect(set.verify.get('x')).toContain('BEGIN PUBLIC KEY');
    expect(set.signing.kid).toBe('x');
  });
});
