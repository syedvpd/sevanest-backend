# Environments and demo safety (DEC-12)

| `APP_ENV` | Meaning | Production guards | Demo OTP flags |
|---|---|---|---|
| `production` (default when `NODE_ENV=production`) | Real users | all | refused at boot |
| `staging` | Shared test service, internet reachable | all (no fake/memory providers, `TRUST_PROXY_HOPS` required, real secrets, Swagger warning) | allowed |
| `development` (default otherwise) | Local work | relaxed | allowed |

`NODE_ENV=production` behaves exactly as before and always counts as production, whatever `APP_ENV` says.

## Demo login

- `ALLOW_TEST_OTP` + `TEST_OTP_NUMBERS` + `TEST_OTP_CODE`: listed numbers log in with a fixed code.
- `DEMO_OTP_ACCEPT_ANY=true` accepts any code for ANY number (no SMS). Optionally set `DEMO_OTP_NUMBERS` (E.164, comma separated) to restrict it; then every other number needs a real OTP.
- Both flags make the process refuse to start when `NODE_ENV=production` or `APP_ENV=production`.
- Staging must not share a database with production or real people's data.

## Staging checklist

1. `NODE_ENV=production`-style secrets and providers (real SMS/storage/payment test-mode), `APP_ENV=staging`, `TRUST_PROXY_HOPS` set.
2. Demo flags on only if needed, with an explicit number list.
3. `GET /api/v1/admin/system/readiness` shows `demo_otp_accept_any` as a warning while the flag is on.
