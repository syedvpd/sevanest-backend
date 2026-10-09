import { randomBytes, scrypt, ScryptOptions, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** scrypt cost parameters (OWASP-recommended memory-hard setting). They are stored in every hash, so they can be raised later. */
const DEFAULT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MEMORY_HEADROOM = 1.25;
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function scryptOptions(N: number, r: number, p: number): ScryptOptions {
  return { N, r, p, maxmem: Math.ceil(128 * N * r * MEMORY_HEADROOM) };
}

/**
 * Slow, salted password hashing using the built-in crypto.scrypt (FR-AUTH-006: admin passwords stored securely).
 * Format: scrypt$N$r$p$salt$hash (base64url). Plain-text passwords are never stored or logged.
 */
@Injectable()
export class PasswordHasher {
  private dummy?: Promise<string>;

  async hash(password: string): Promise<string> {
    const { N, r, p } = DEFAULT_PARAMS;
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(password, salt, KEY_LENGTH, scryptOptions(N, r, p));
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  /** Constant-time comparison. A malformed stored value never matches (and never throws). */
  async verify(password: string, stored: string): Promise<boolean> {
    const match = FORMAT.exec(stored);
    if (!match) {
      return false;
    }
    const [, n, r, p, saltText, keyText] = match;
    const expected = Buffer.from(keyText, 'base64url');
    try {
      const actual = await deriveKey(
        password,
        Buffer.from(saltText, 'base64url'),
        expected.length,
        scryptOptions(Number(n), Number(r), Number(p)),
      );
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  /**
   * A valid hash of a random password, used to spend the same time when the account does not exist so that
   * response timing does not reveal which admin emails are registered.
   */
  dummyHash(): Promise<string> {
    this.dummy ??= this.hash(randomBytes(24).toString('base64url'));
    return this.dummy;
  }
}
