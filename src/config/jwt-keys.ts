import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

/** One ES256 key of the JWT_KEYS set. `privateKey` is present only on the signing key. */
export interface ParsedJwtKey {
  kid: string;
  /** PEM (spki). Always present: derived from the private key when only that was given. */
  publicKey: string;
  /** PEM (pkcs8). Only the first entry of JWT_KEYS signs. */
  privateKey?: string;
}

export interface JwtKeySet {
  /** The key new tokens are signed with (always the first entry). */
  signing: { kid: string; privateKey: string };
  /** Every key a token may be verified with: the signing key plus the previous ones kept during rotation. */
  verify: ReadonlyMap<string, string>;
}

const KID_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
const MAX_KEYS = 5;

function asKey(pem: string, kind: 'private' | 'public', kid: string): KeyObject {
  try {
    return kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
  } catch {
    throw new Error(`JWT_KEYS: key "${kid}" has an unreadable ${kind} PEM`);
  }
}

function assertP256(key: KeyObject, kid: string): void {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`JWT_KEYS: key "${kid}" must be an EC P-256 key (ES256)`);
  }
}

/**
 * Parses JWT_KEYS: a JSON array `[{"kid":"2026-10","privateKey":"-----BEGIN PRIVATE KEY-----..."},{"kid":"2026-04","publicKey":"..."}]`.
 * The FIRST entry signs and needs a private key; later entries are only used to verify tokens issued before a rotation.
 * Throws a descriptive Error (no key material in the message) so a bad set fails at boot, never at the first login.
 */
export function parseJwtKeys(raw: string): JwtKeySet {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('JWT_KEYS must be a JSON array of {kid, privateKey?, publicKey?}');
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_KEYS) {
    throw new Error(`JWT_KEYS must hold 1 to ${MAX_KEYS} keys`);
  }
  const verify = new Map<string, string>();
  let signing: JwtKeySet['signing'] | null = null;
  list.forEach((entry: unknown, index) => {
    const item = (entry ?? {}) as { kid?: unknown; privateKey?: unknown; publicKey?: unknown };
    if (typeof item.kid !== 'string' || !KID_PATTERN.test(item.kid)) {
      throw new Error('JWT_KEYS: every key needs a kid of 1-40 letters, digits, . _ -');
    }
    if (verify.has(item.kid)) throw new Error(`JWT_KEYS: duplicate kid "${item.kid}"`);
    const unescape = (pem: string): string => pem.replace(/\\n/g, '\n');
    let publicPem: string;
    if (typeof item.privateKey === 'string') {
      const privateKey = asKey(unescape(item.privateKey), 'private', item.kid);
      assertP256(privateKey, item.kid);
      const publicKey = createPublicKey(privateKey);
      publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      if (index === 0) {
        signing = {
          kid: item.kid,
          privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        };
      }
    } else if (typeof item.publicKey === 'string') {
      const publicKey = asKey(unescape(item.publicKey), 'public', item.kid);
      assertP256(publicKey, item.kid);
      publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    } else {
      throw new Error(`JWT_KEYS: key "${item.kid}" needs a privateKey or a publicKey`);
    }
    verify.set(item.kid, publicPem);
  });
  if (!signing)
    throw new Error('JWT_KEYS: the first key must have a privateKey (it signs new tokens)');
  return { signing, verify };
}
