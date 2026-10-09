import { PasswordHasher } from './password-hasher.service';

// scrypt is deliberately slow and memory-hard; under CPU contention the default 5 s timeout is too tight.
jest.setTimeout(30000);

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true);
    expect(await hasher.verify('correct horse battery stapl3', hash)).toBe(false);
    expect(await hasher.verify('', hash)).toBe(false);
  });

  it('is salted: the same password never produces the same hash', async () => {
    const [a, b] = await Promise.all([
      hasher.hash('same-password-1'),
      hasher.hash('same-password-1'),
    ]);
    expect(a).not.toBe(b);
  });

  it('stores parameters in a self-describing format and never the password', async () => {
    const hash = await hasher.hash('visible-secret-123');
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain('visible-secret-123');
  });

  it.each(['', 'plaintext', 'scrypt$1$2$3$a$b', 'scrypt$x$8$1$AAAA$BBBB', 'bcrypt$abc'])(
    'never matches (and never throws on) malformed stored value %p',
    async (stored) => {
      await expect(hasher.verify('anything', stored)).resolves.toBe(false);
    },
  );

  it('rejects absurd cost parameters instead of exhausting memory', async () => {
    const hash = await hasher.hash('pw-pw-pw-pw-pw');
    const parts = hash.split('$');
    parts[1] = String(2 ** 30);
    await expect(hasher.verify('pw-pw-pw-pw-pw', parts.join('$'))).resolves.toBe(false);
  });

  it('provides one reusable dummy hash for constant-time failure paths', async () => {
    const first = await hasher.dummyHash();
    expect(await hasher.dummyHash()).toBe(first);
    expect(await hasher.verify('not-the-random-password', first)).toBe(false);
  });
});
