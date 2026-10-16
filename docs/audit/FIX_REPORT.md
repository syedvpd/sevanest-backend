# Fix report: 2026-10-16 audits

Branch `fix/audit-2026-10-16`, one commit per work package. Source audits: `SevaNest_Deep_Audit_2026-10-16.md` (gaps #1-#24), `SevaNest_Forensic_Audit_09721fc.md` (N-xx, F-xx, S-xx). The two audit files were not in the repo; their findings are quoted by ID below.

Status: **FIXED_VERIFIED** = a named test ran and passed (results in section 3); **FIXED_NOT_EXECUTED** = code exists, not run; **DEFERRED** / **NOT_DONE** = reason given.

## 1. Findings

| Finding | What changed | Status | Evidence (test file) |
|---|---|---|---|
| N-01 timers off, unpaid lock | Built-in defaults, 0 disables, readiness shows ON/OFF, render.yaml / .env.example | FIXED_VERIFIED | `env.validation.spec.ts`, `booking-sweep.service.spec.ts`, `gap.closing.int-spec.ts` |
| N-02 demo OTP any number | `APP_ENV`, `DEMO_OTP_NUMBERS` allow-list, refused in production | FIXED_VERIFIED | `env.validation.spec.ts` |
| N-03 future migration dates | No rename; `npm run check:migrations` CI guard; rule in `docs/DATABASE_MIGRATION.md` | FIXED_VERIFIED | `migration-order.spec.ts`; guard run against origin/main |
| N-04 stale OPEN_BLOCKERS | Rewritten; traceability, RBAC, closure register updated | FIXED_VERIFIED (docs) | `docs/qa/*` |
| N-05 sweepers in every replica | Already safe (dedupe keys, locked cancel); reassign path uses the same lock | FIXED_VERIFIED | `gap.closing.int-spec.ts` |
| F-10 refresh replay | 10 s grace, same device, 409 `REFRESH_IN_PROGRESS` | FIXED_VERIFIED | `auth.api.int-spec.ts` |
| F-14 OTP request state leak | Identical answer; suspended / wrong-app get no SMS | FIXED_VERIFIED | `auth.api.int-spec.ts` |
| F-21 HS256 only | ES256 + `kid`, rotation, legacy window | FIXED_VERIFIED | `token.service.es256.spec.ts` |
| F-18 worker healthcheck | `dist/worker-healthcheck.js`, compose probe | FIXED_VERIFIED | `ops.hardening.int-spec.ts` |
| S-09 refused-request audit volume | First row per minute + one count row | FIXED_VERIFIED | `ops.hardening.int-spec.ts` |
| S-13 503 logged as ERROR | Handled 503 is a warning | FIXED_VERIFIED | `all-exceptions.filter.spec.ts` |
| S-14 / P-1 audit offset paging | Keyset cursor + index | FIXED_VERIFIED | `ops.hardening.int-spec.ts` |
| S-11 typescript in prod image | `--omit=peer` does not remove it (comes via `@prisma/client`) | NOT_DONE (no safe way) | measured, see OPEN_BLOCKERS R-6 |
| Gap 1 earnings reference (FR-WJ-008) | `worker_payment_references`, append-only, admin record/correct/void, worker read | FIXED_VERIFIED | `earnings.api.int-spec.ts` |
| Gap 2 SLA auto-escalate | Escalates once, system event, owner notice | FIXED_VERIFIED | `gap.closing.int-spec.ts` |
| Gap 3 blacklist | Flag, suspension, exclusion, alerts, Super-Admin lift | FIXED_VERIFIED | `worker.blacklist.int-spec.ts` |
| Gap 4 concurrent edits | `If-Match` required (428/412) on users, areas, categories, customers, workers, templates, fees, tickets | FIXED_VERIFIED | `admin.concurrency.int-spec.ts`, `fees.catalogue.int-spec.ts` |
| Gap 5 cancellation / refund | Auto full refund before ACTIVE, failures to exception queue, `CANCELLATION_FEE` = 0 | FIXED_VERIFIED | `payments.recovery.int-spec.ts`, `payment.api.int-spec.ts` |
| Gap 6 request admin matching | `canRequestAdminMatching`, alert on worker-less request | FIXED_VERIFIED | `gap.closing.int-spec.ts` |
| Gap 7 no alternative alert | Staff alert, auto-resolves | FIXED_VERIFIED | `replacement.api.int-spec.ts` |
| Gap 8 photo required | `PHOTO_REQUIRED`, 5 MB default | FIXED_VERIFIED | `worker.photo.required.int-spec.ts` |
| Gap 9 verification badges | Not in the WP list | NOT_DONE | not requested |
| Gap 10 monthly engagement | `MONTHLY` alias of existing `MONTH` | FIXED_VERIFIED | `gap.closing.int-spec.ts` |
| Gap 11 revenue models | Fee kinds, CRUD, generic fee payment; subscriptions / B2B only catalogued | FIXED_VERIFIED (placement, verification, replacement plan) / DEFERRED (subscription, B2B) | `fees.catalogue.int-spec.ts` |
| Gap 12 safety to Ops / Super | Alert needs `worker.manage` | FIXED_VERIFIED | `gap.closing.int-spec.ts` |
| Gap 13 emergency-contact reveal | Redacted in staff view; reveal with reason, audited | FIXED_VERIFIED | `worker.blacklist.int-spec.ts` |
| Gap 14 e-mail channel | Brevo / disabled / memory, templates, opt-out | FIXED_VERIFIED (mocked HTTP) / live NOT_EXECUTED | `email.channel.int-spec.ts`, `email-providers.spec.ts` |
| Gap 15 maps | Google / disabled / memory, geocode on save, `DISTANCE_ASC` | FIXED_VERIFIED (mocked HTTP) / live NOT_EXECUTED | `maps.int-spec.ts`, `maps-providers.spec.ts` |
| Gap 16 export coverage | Not in the WP list | NOT_DONE | not requested |
| Gap 17 general sort contract | Only `DISTANCE_ASC` added | NOT_DONE | not requested |
| Gap 18 retention / erasure | Tasks, erasers, cooling-off, reject, dry-run, preview; OFF by default; audit archive not built | FIXED_VERIFIED / DEFERRED (audit archive) | `retention.int-spec.ts` |
| Gap 24 sweepers | See N-05 | FIXED_VERIFIED | as N-05 |
| External: gateway, SMS+DLT, FCM, S3, backups, CI | Cannot be closed by code | NOT_DONE (owner) | see section 4 |
| Baseline red tests on main | Stale KYC link test and module-boundary test | FIXED_VERIFIED | `kyc.integrity.int-spec.ts`, `modules.workforce.int-spec.ts` |

## 2. Migrations added (all additive, none edits an existing one)

`20261102` cancellation fee row + zero-fee check, `20261103` session rotated_at, `20261104` ticket-event system actor, `20261105` worker payment references (+ trigger), `20261106` worker blacklist, `20261107` fee kinds + per-fee payment uniqueness, `20261108` deletion-request reject, `20261109` EMAIL channel + e-mail preference, `20261110` approximate worker location, `20261111` audit keyset index.

Note: `20261107` replaces the unique index "one open payment per booking" with "one open payment per booking and fee". The booking-fee guarantee is unchanged; extra fees may coexist.

## 3. Verification run (final gate)

See the block appended by the gate run below.

## 4. Things only the owner can do

1. Provider credentials and one live run each: Razorpay (test then live) + webhook secret, MSG91 / Twilio + DLT template, FCM service account, Brevo key + validated sender, Google Maps key, S3 bucket with size limits.
2. Enable Render / Supabase backups and do one restore drill.
3. Push the branch, open the PR, get a green GitHub Actions run (this was not seen).
4. Provision `JWT_KEYS` (see `docs/JWT_ROTATION.md`) and, later, drop HS256.
5. Map the new permissions onto existing roles (`PUT /admin/roles/{code}/permissions`); update the admin app to send `If-Match` (or set `ADMIN_IF_MATCH_REQUIRED=false` meanwhile); add the timer env vars to existing Render services.
6. Legal text and retention periods, then `RETENTION_ENABLED=true` (dry run first).
7. Sign off every row of `DECISIONS_NEEDING_OWNER_SIGNOFF.md`, especially refund, wage-reference, retention and blacklist.
