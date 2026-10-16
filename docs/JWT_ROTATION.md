# JWT signing keys and rotation (DEC-19)

Access tokens are ES256 (ECDSA P-256) with a `kid` header when `JWT_KEYS` is set. Without it the service keeps the legacy HS256 shared secret
(`JWT_ACCESS_SECRET`) and logs a `ConfigWarning` in production and staging. Refresh tokens are opaque and unaffected.

## Configuration

`JWT_KEYS` is a one-line JSON array. The **first** entry signs new tokens (needs `privateKey`); later entries only verify older tokens
(`publicKey` is enough). At most 5 keys, `kid` of 1-40 letters/digits/`._-`, all EC P-256.

```
JWT_KEYS=[{"kid":"2026-11","privateKey":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"},{"kid":"2026-04","publicKey":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}]
```

Generate a key pair (keep the private key out of git, logs and chat):

```bash
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out jwt-2026-11.pem
openssl ec -in jwt-2026-11.pem -pubout -out jwt-2026-11.pub.pem
```

## Migrating from HS256 (one-off)

1. Add `JWT_KEYS` with the new signing key **and** set `JWT_LEGACY_HS256_UNTIL` to now + the access-token lifetime + a margin
   (e.g. one hour), keeping `JWT_ACCESS_SECRET`. New tokens are ES256; tokens issued before the deploy keep working until they expire.
2. After that time, remove `JWT_LEGACY_HS256_UNTIL` and `JWT_ACCESS_SECRET`. HS256 tokens are then refused (default).

## Rotating a key

1. Generate a new pair. Put it **first** in `JWT_KEYS`; keep the previous key as a public-only entry after it. Deploy all API replicas.
2. Wait at least `JWT_ACCESS_TTL_SECONDS` (tokens signed by the old key expire on their own).
3. Remove the old entry and deploy again. A token carrying an unknown `kid` is refused with 401.

Emergency (key leaked): put the new key first and **drop the leaked key at once**. Everyone is logged out of their access token and the apps
refresh with their refresh token, so users stay signed in.

## What is checked

ES256 tokens are verified only against the configured public key selected by `kid`; HS256 only against the legacy secret and only inside the
window; `alg=none`, unknown `kid`, wrong issuer/audience and expired tokens are refused. The public key is never used as an HMAC secret.
Tests: `src/modules/auth/token.service.es256.spec.ts`.
