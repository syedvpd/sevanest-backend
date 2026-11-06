# Worker Wallet, Earnings, Bank Accounts & Registration (DOB / Gender) — Backend Gap Audit

**Date:** 2026-11-05 · **Branch:** `main` @ `5bc662c` · **Type:** READ-ONLY audit + implementation plan (no code, no schema, no API changes were made)

**Scope:** 9 requested capabilities — wallet summary, bank accounts, earnings analytics, recent earnings/transactions, withdrawals, payout history, worker registration `dateOfBirth`, `gender`, draft persistence/resume for both.

**Evidence basis (all observed in this session):**
`git status` / `git log`, `docs/openapi.json` route inventory, full `src/modules/**` and `prisma/schema.prisma` greps, `prisma/migrations` greps, live PostgreSQL `information_schema` queries (local docker), and real test runs (commands + counts in §J).

**Governance reading (spec §2.1):** `AGENTS.md`, `CLAUDE.md`, `MAP.md`, `docs/project-intelligence/CURRENT_STATE.md`, `docs/project-intelligence/DECISION_INDEX.md`, `docs/project-intelligence/OPEN_QUESTIONS.md`, `docs/project-intelligence/IMPLEMENTATION_STATUS.md` were read. **`MEMORY.md` and `DECISIONS.md` do not exist in this repository** — their roles are covered by `CURRENT_STATE.md` and `DECISION_INDEX.md` respectively (per `MAP.md`).

---

## A. Executive Summary

**The current backend does not support a worker wallet, bank accounts, withdrawals, payouts, escrow, or payout history. None of those exist as models, migrations, DTOs, services, controllers, tests or routes.** Searching the whole repo for `wallet|payout|withdraw|bank account|ifsc|BankAccount|WalletDto|PayoutDto|WithdrawalDto` returns only customer-payment display strings (Razorpay method detail) and the audit-log redaction key list — no domain code.

What *does* exist for money:

1. **`payments`** — the **customer → platform** booking/fee payments (Razorpay, webhooks, refunds, reconciliation). This is customer money, never worker money (`prisma/schema.prisma:844`).
2. **`worker_payment_references`** — an **informational, append-only wage ledger**: staff record that a customer paid a worker **off-platform**. The platform never calculates, holds or pays wages (`prisma/schema.prisma:1601`, `src/modules/earnings/earnings.service.ts:34-38`). Worker endpoint: `GET /api/v1/workers/me/earnings` (read-only, paginated, with a lifetime total).

Because there is no balance ledger, **no amount can honestly be labelled "available for withdrawal" or "escrowed" today.** The only worker-facing money figure that is backed by records is **"total of recorded off-platform wage payments"** (`totals.amountMinor`) and the individual **"recorded wage payment"** entries.

For registration: **`dateOfBirth` and `gender` do not exist anywhere** — not in Prisma, not in any migration, not in any DTO, not in any response, not in any test (grep across `src/`, `prisma/`, `test/` returns zero domain matches). The **draft/save/resume mechanism does exist** and is generic (partial `PATCH /workers/me`, `missingForSubmission`, `GET /workers/me/onboarding`), so both fields can be added to the existing endpoints — no new endpoint is required.

| Requested capability | Verdict |
|---|---|
| A. Wallet summary | **NOT IMPLEMENTED** (no wallet, no balance to summarize) |
| B. Bank account management (CRUD + verification) | **NOT IMPLEMENTED** (no model, no endpoint, no provider) |
| C. Earnings analytics (periods, daily, category) | **NOT IMPLEMENTED** (no aggregation endpoint; source rows partially exist) |
| D. Recent earnings / transaction history | **PARTIALLY IMPLEMENTED** — `GET /workers/me/earnings` exists but has no date/type/status filters and is a wage-reference list, not a transaction ledger |
| E. Withdrawal requests | **NOT IMPLEMENTED** (and must not be built on the current data model) |
| F. Payout history & tracking | **NOT IMPLEMENTED** |
| G. Wallet business rules | **BUSINESS CONFIRMATION REQUIRED** (Q-73 still open) |
| H1. Registration `dateOfBirth` | **NOT IMPLEMENTED** — needs schema + DTO + validation |
| H2. Registration `gender` | **NOT IMPLEMENTED** — needs enum decision first (**BUSINESS CONFIRMATION REQUIRED**) |
| H3. Draft persistence / resume for both | **mechanism already IMPLEMENTED AND VERIFIED**; the two fields themselves are missing |

### A.1 Direct answers to the nine Part A determinations (spec §3)

| # | Determination question | Answer | Evidence |
|---|---|---|---|
| 1 | Is there a real worker wallet ledger? | **No.** Only an append-only *wage-reference* ledger (`worker_payment_references`) recording off-platform payments staff observed; no balance, no ledger entries, no wallet account | `schema.prisma:1601`; live DB: 0 tables matching `%wallet%` |
| 2 | Are earnings created from completed bookings or shifts? | **No automatic creation.** Rows are created manually by staff via `POST /admin/wage-payments`, only for a **started** booking with an assigned worker (`BOOKING_NOT_STARTED` / `NO_WORKER_ASSIGNED` guards) | `earnings.service.ts:53-70`, `earnings.controller.ts:61-76` |
| 3 | Are earnings pending until a defined business event? | **No pending state exists.** Rows are recorded as already-paid-off-platform; there is no pending/escrow status on any worker money row | `WorkerPaymentReference` fields (`schema.prisma:1601-1625`) |
| 4 | Is there a settlement or release mechanism? | **No.** D-102: "zero escrow/payout in V1"; no settlement/release code anywhere | `DECISION_INDEX.md` D-102, `Q-73` open |
| 5 | Is the available balance calculated from financial records? | **No available-balance calculation exists** (nothing computes one). The only computed figure is `totals.amountMinor` = SUM of counted reference rows | `earnings.service.ts:127-136` |
| 6 | Are withdrawals deducted or reserved atomically? | **N/A — no withdrawals exist.** The row-lock pattern to use when built is proven elsewhere (`SELECT … FOR UPDATE` inside `$transaction`) | `workers.repository.ts:205-208`, `booking.repository.ts:227-230` |
| 7 | Are refunds, cancellations and reversals accounted for? | **Customer side only** (`Payment.refundedAt`, `PaymentException` kinds). Worker-side: corrections/voids are *new compensating rows*, never edits (append-only trigger) | `schema.prisma:865-867`, `earnings.service.ts:174-212` |
| 8 | Is currency stored or configured? | **Stored per row** (`currency String @default("INR")`), but the worker view's `totals.currency` is **hard-coded `'INR'`** in service code | `schema.prisma:1604`, `earnings.service.ts:136` |
| 9 | Is the balance calculation protected against duplicate processing? | Partially: writes are `@Idempotent()` + DB append-only trigger; there is no balance to duplicate-protect. Provider-side duplicate callbacks are deduped by unique `providerEventId` | `idempotency.interceptor.ts`, `PaymentEvent` `schema.prisma:894` |

---

## B. Existing Endpoint Inventory (verified from controllers + committed OpenAPI)

### B.1 Worker-facing (auth: `Authorization: Bearer <accessToken>`, `@RequireUserType('WORKER')`)

| Method | Route | Controller / action |
|---|---|---|
| POST | `/api/v1/workers/me` | `WorkersController.create` — start profile (409 if exists) |
| GET | `/api/v1/workers/me` | `WorkersController.get` — profile + `missingForSubmission` |
| PATCH | `/api/v1/workers/me` | `WorkersController.update` — **partial step save (this is the draft save)** |
| PUT | `/api/v1/workers/me/categories` | `setCategories` |
| PUT | `/api/v1/workers/me/criminal-declaration` | `setCriminalDeclaration` |
| GET/PUT | `/api/v1/workers/me/references` | `getReferences` / `setReferences` |
| POST | `/api/v1/workers/me/submit` | `submit` — DRAFT → SUBMITTED (422 `PROFILE_INCOMPLETE`) |
| GET | `/api/v1/workers/me/onboarding` | `WorkerOnboardingController.get` — **resume view** (steps, `nextStep`, `missing`) |
| **GET** | **`/api/v1/workers/me/earnings`** | `WorkerEarningsController.list` — **the only worker money endpoint** |
| GET | `/api/v1/workers/me/bookings[/{id}]`, `/opportunities`, `/interviews…`, `/attendance/bookings/{id}[/summary]`, `/ratings[/summary]`, `/availability`, `/photo`, `/verification` | other modules |

### B.2 Financial / staff (auth: Bearer, `@RequireUserType('ADMIN')` + permission)

| Method | Route | Permission |
|---|---|---|
| POST | `/api/v1/admin/wage-payments` (`@Idempotent()`) | `payment.manage` |
| POST | `/api/v1/admin/wage-payments/{id}/correct` (`@Idempotent()`) | `payment.manage` |
| POST | `/api/v1/admin/wage-payments/{id}/void` (`@Idempotent()`) | `payment.manage` |
| GET | `/api/v1/admin/wage-payments` (filters: `workerId`, `bookingId`, `page`, `limit`) | `payment.view` |
| POST | `/api/v1/payments`, `/payments/{id}/verify`, GET `/payments[/{id}][/receipt[/pdf]]` | customer, booking fee |
| POST | `/api/v1/webhooks/payments` | Razorpay webhook (HMAC signature verified) |
| GET | `/api/v1/admin/payments[/…]`, POST `/admin/payments/{id}/refund`, `/reconcile`, GET `/admin/payment-exceptions…` | `payment.view` / `payment.refund` / `payment.manage` |
| GET/POST/PATCH/DELETE | `/api/v1/fees/*`, `/api/v1/admin/fees/*`, `/fee-payments` | fee catalogue |

### B.3 Routes that DO NOT exist (checked in `src/**` and `docs/openapi.json`)

`/workers/me/wallet/**`, `/workers/me/bank-accounts/**`, `/workers/me/wallet/withdrawals`, `/workers/me/wallet/payouts/**`, `/workers/me/wallet/analytics`, `/workers/me/wallet/transactions` — **absent**.

> **OpenAPI caveat:** the committed `docs/openapi.json` was last regenerated on 2026-11-03 (`01b777b`) and is now **stale**: at least `POST /admin/notifications/test-push`, `POST /notifications/test-push`, `POST /notifications/{id}/ack` exist in code but not in the file. The live document is served at `GET /docs/openapi.json` (`src/app.setup.ts:57`, `SWAGGER_ENABLED=true`). Route-absence above was verified against **source code**, not only the file.

---

## C. Feature-by-Feature Gap Matrix

Status vocabulary used exactly as specified.

| Capability | Existing implementation | Evidence | Status |
|---|---|---|---|
| Worker wallet balance | Nothing computes a balance; no `Wallet`/`LedgerEntry` table | `prisma/schema.prisma` models list has no wallet; `information_schema` query on the test DB: 0 tables matching `%wallet%|%bank%|%payout%|%withdraw%` | **NOT IMPLEMENTED** |
| Pending earnings | No pending/escrow state on any money row | `PaymentStatus` = CREATED…REFUND_FAILED (customer side only), `schema.prisma:809` | **NOT IMPLEMENTED** |
| Escrow | None; decision record says V1 has zero escrow | `DECISION_INDEX.md` D-102 ("confirmed zero escrow/payout in V1 (wages offline, Q-73)"); `CURRENT_STATE.md:131` | **NOT IMPLEMENTED** (decided out of V1 scope) |
| Earnings ledger | Append-only wage **reference** rows staff record off-platform | `WorkerPaymentReference` `schema.prisma:1601`, DB trigger blocks UPDATE/DELETE (proven in test), `COUNTED` filter `earnings.repository.ts:43` | **IMPLEMENTED AND VERIFIED** (as a *reference* ledger, not payroll) |
| Bank account storage | none | grep `BankAccount|account_number|ifsc` in `src/` → only redaction key list | **NOT IMPLEMENTED** |
| Bank account verification | none (no provider, no status field) | `src/integrations/` has payments/notifications/storage/verification(KYC)/maps only | **NOT IMPLEMENTED** |
| Worker withdrawal | none | no model/controller/service/test | **NOT IMPLEMENTED** |
| Manual payout | none (staff record an *off-platform* wage, the platform moves no money) | `earnings.controller.ts:66-69` "The platform moves no money" | **NOT IMPLEMENTED** |
| Automated payout | none | — | **NOT IMPLEMENTED** |
| Platform incentives | no incentive concept anywhere | grep `incentive` → 0 hits in `src/`, `prisma/` | **NOT IMPLEMENTED** |
| Payout history | none | — | **NOT IMPLEMENTED** |
| Refund/reversal accounting | **customer-side only**: refund endpoint, `Payment.refundedAt/refundReason/refundProviderId`, `PaymentException` kinds `PAID_BOOKING_CANCELLED`, `DUPLICATE_PAYMENT`, `REFUND_STUCK` | `schema.prisma:865-867`, `payment.controller.ts:313` | **IMPLEMENTED AND VERIFIED** for customer money; **NOT IMPLEMENTED** for worker-side reversals |
| Earnings history (worker) | `GET /workers/me/earnings` list + totals | `earnings.controller.ts:34-47` | **IMPLEMENTED AND VERIFIED** |
| Earnings analytics | none (no period/daily/category aggregation for a worker) | no service/repository method; reports module has no worker-earnings report | **NOT IMPLEMENTED** |
| Transaction ledger with filters | none (earnings list has only `page`/`limit`) | `PageQueryDto` `pagination.ts:12` | **PARTIALLY IMPLEMENTED** |
| Registration `dateOfBirth` | absent | 0 hits in `src/`, `prisma/`, `migrations/`, `test/` | **NOT IMPLEMENTED** |
| Registration `gender` | absent | same | **NOT IMPLEMENTED** (enum values need business sign-off) |
| Draft save / resume (generic) | `PATCH /workers/me` partial save, `missingForSubmission`, `GET /workers/me/onboarding` | `workers.service.ts:273`, `:860`, `worker-onboarding.controller.ts` | **IMPLEMENTED AND VERIFIED** |
| Draft persistence of DOB/gender | n/a — fields do not exist yet | — | **NOT IMPLEMENTED** |

### What may safely be shown to a worker today (label discipline)

| UI label | Backed by backend records? | Source |
|---|---|---|
| Earnings history | ✅ yes | `GET /workers/me/earnings` → `data[]` (`amountMinor`, `periodLabel`, `method`, `referenceText`, `recordedAt`) |
| Total earned to date | ✅ yes, with the caveat "recorded off-platform wage payments" | `totals: { currency: 'INR', amountMinor, paymentCount }` |
| Completed-booking earnings reference | ✅ yes | each entry carries `bookingId` |
| Pending earnings / escrow | ❌ **no** — no record type exists | — |
| Available withdrawal balance | ❌ **no** — no balance, no withdrawal rules | — |
| Estimated earnings | ❌ **no** — pricing guidance is customer-facing (`GET /pricing/guidance`), no worker payout rate | — |

---

## D. Prisma Database Evidence

| Model / enum | File | Relevance |
|---|---|---|
| `WorkerProfile` (`worker_profiles`) | `schema.prisma:384-450` | Registration target. Fields: `name`, `onboardingStatus`, `submittedAt`, `experienceMonths`, `expectedSalary Decimal(12,2)`, `preferredLanguage`, address/emergency/previous-employer columns, `profilePhotoRef`, criminal declaration, blacklist, geo, `applicationReference`, sign-off/activation stamps. **No `dateOfBirth`, no `gender`.** Relation `paymentReferences WorkerPaymentReference[]` (line 446). |
| `WorkerPaymentReference` (`worker_payment_references`) | `schema.prisma:1601-1625` | The only worker money table: `amountMinor Int`, `currency String @default("INR")`, `periodLabel`, `method WagePaymentMethod`, `referenceText`, `correctsId` (unique), `isVoid`, `recordedByUserId`, `recordedAt`. Append-only (DB trigger, verified by test). |
| `WagePaymentMethod` | `schema.prisma:1590` | `CASH \| BANK_TRANSFER \| UPI \| CHEQUE \| OTHER` — a *label of how the customer paid*, not a payout rail. |
| `Payment` (`payments`) | `schema.prisma:844-891` | Customer→platform money: `amountMinor Int`, `currency`, `status`, `providerOrderId/Id`, `paidAt`, refund fields, reconciliation claim columns. **No worker column.** |
| `PaymentEvent` | `schema.prisma:894` | webhook dedupe (`providerEventId` unique) — the duplicate-callback protection pattern. |
| `PaymentException` | `schema.prisma:942` | `DUPLICATE_PAYMENT`, `PAID_BOOKING_CANCELLED`, `REFUND_STUCK`… |
| `FeeConfig` | `schema.prisma:831` | Admin-configured fees, `currency @default("INR")`. |
| `AttendanceRecord` / `AttendanceEvent` | `schema.prisma:1077`, `:1103` | Per `(bookingId, date)`, `status ∈ PRESENT/ABSENT/EXCEPTION/LATE/LEAVE`, check-in/out stamps, `@@index([workerId, date])` — the natural base for "completed shift" analytics. |
| `Booking` | `schema.prisma:723` | Lifecycle incl. `COMPLETED` (transition `ACTIVE → COMPLETED` by CUSTOMER/ADMIN, `booking.service.ts:131`). |
| `ServiceCategory` | `schema.prisma:299` | **Table-driven categories, not an enum**: seeded codes `HOUSE_MAID, DRIVER, COOK, BABYSITTER, ELDERLY_CARE_HELPER, CLEANING_HELPER` (verified live: `SELECT code,name FROM service_categories`). |
| **Missing entirely** | — | no `Wallet`, `WalletLedgerEntry`, `BankAccount`, `Withdrawal`, `Payout`, `Escrow`, `Settlement`, `Transaction` model; no `gender`, `date_of_birth` column anywhere (verified via `information_schema.columns` on `worker_profiles`) |

**Money arithmetic convention:** all amounts are **integer minor units (paise)** — `amountMinor Int` on `Payment`, `FeeConfig`, `WorkerPaymentReference`. This is the decimal-safe pattern a wallet must follow; nothing currently uses floats.

---

## E. Existing Request/Response Examples (actual DTOs)

### E.1 `GET /api/v1/workers/me/earnings` (IMPLEMENTED)

- **Auth:** Bearer, user type WORKER. **Query:** `page` (≥1, default 1), `limit` (1–100, default 20).
- **Errors:** 400 `VALIDATION_FAILED`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 429, 500, 503 (all documented in OpenAPI).

```jsonc
// 200 — WorkerEarningsView (src/modules/earnings/dto/earnings.dto.ts:118)
{
  "data": [
    {
      "id": "0199…",
      "bookingId": "0198…",
      "amountMinor": 300000,
      "currency": "INR",
      "periodLabel": "2026-11",
      "method": "UPI",
      "referenceText": "UPI ref 4821",
      "recordedAt": "2026-11-03T10:20:30.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 3 },
  "totals": { "currency": "INR", "amountMinor": 1900000, "paymentCount": 3 }
}
```

Notes: no `workerId`/`recordedByUserId` in the worker view (privacy), totals cover **all** counted entries not just the page, corrected/void rows excluded (`earnings.repository.ts:43`). `currency` in `totals` is currently **hard-coded `'INR'`** (`earnings.service.ts:136`).

### E.2 `POST /api/v1/admin/wage-payments` (staff only)

```jsonc
// request — CreateWagePaymentDto (dto/earnings.dto.ts:46)
{ "bookingId": "uuid", "amountMinor": 1200000, "periodLabel": "2026-11",
  "method": "UPI", "referenceText": "UPI ref 4821" }   // optional header: Idempotency-Key
// 201 AdminWagePaymentView = WagePaymentView + workerId, recordedByUserId, correctsId, isVoid, superseded
```
Domain errors: `409 NO_WORKER_ASSIGNED`, `409 BOOKING_NOT_STARTED`, `404 WAGE_PAYMENT_NOT_FOUND`, `409 WAGE_PAYMENT_ALREADY_CORRECTED`, `409 WAGE_PAYMENT_IS_VOID`, `400 VALIDATION_FAILED` (`amountMinor` 1…1_000_000_000 int, `periodLabel` 1–40, `method` enum, `referenceText` ≤200).

### E.3 Registration endpoints (exact, current)

| Method + route | Body DTO | Response |
|---|---|---|
| `POST /api/v1/auth/otp/request` | `{ mobile, appType: 'WORKER' }` | `OtpRequestedResponse` |
| `POST /api/v1/auth/otp/verify` | `{ mobile, appType, otp, deviceId?, deviceName? }` | `TokenResponse` (`isNewUser` tells the app to create the profile) |
| `POST /api/v1/workers/me` | `CreateWorkerProfileDto { name }` | `WorkerProfileResponse` (201, 409 `WORKER_PROFILE_EXISTS`) |
| **`PATCH /api/v1/workers/me`** | `UpdateWorkerProfileDto` — **all optional**: `name?`, `experienceMonths?`, `expectedSalary?`, `preferredLanguage?`, `languages?`, `address?{line,area,city,pincode}`, `emergencyContact?{name,mobile}`, `previousEmployer?{name,mobile}\|null` | `WorkerProfileResponse` |
| `PUT /api/v1/workers/me/categories` | `{ categoryIds: uuid[] }` (1–20, unique) | `WorkerProfileResponse` |
| `PUT /api/v1/workers/me/references` | `{ references: [{name,mobile,relationship?}] }` (≤5) | `WorkerReferenceView[]` |
| `PUT /api/v1/workers/me/criminal-declaration` | `{ hasCriminalRecord, details?, accepted: true }` | `WorkerProfileResponse` |
| `POST /api/v1/workers/me/submit` | — | `WorkerProfileResponse` (422 `PROFILE_INCOMPLETE` + `details[0].messages = missing[]`, 422 `PHOTO_REQUIRED`) |
| `GET /api/v1/workers/me` / `GET /api/v1/workers/me/onboarding` | — | profile / step-resume view |
| `POST /api/v1/admin/workers` | `AdminCreateWorkerDto { name, mobile }` | `AdminWorkerDetail` |
| `PATCH /api/v1/admin/workers/{workerId}` (+ `If-Match` ETag) | `UpdateWorkerProfileDto` | `AdminWorkerDetail` (412 `STALE_VERSION`) |

`WorkerProfileResponse` properties today (from OpenAPI): `id, name, mobile, onboardingStatus, applicationReference, submittedAt, experienceMonths, expectedSalary, preferredLanguage, languages, address, emergencyContact, previousEmployer, hasProfilePhoto, criminalDeclaration, categories, missingForSubmission, createdAt, updatedAt`.

**Draft semantics:** "Only the fields sent change" (`workers.controller.ts:74-86`); grouped objects are replaced whole, `previousEmployer: null` clears (`workers.service.ts:935-959`). Status/photo/ownership are not writable. This is the existing draft + resume contract.

### E.4 Per-endpoint contract records (spec §11 format) — relevant existing endpoints

| | `GET /workers/me/earnings` | `PATCH /workers/me` | `POST /workers/me/submit` | `GET /workers/me/onboarding` | `POST /admin/wage-payments` |
|---|---|---|---|---|---|
| **Implementation status** | IMPLEMENTED AND VERIFIED | IMPLEMENTED AND VERIFIED | IMPLEMENTED AND VERIFIED | IMPLEMENTED AND VERIFIED | IMPLEMENTED AND VERIFIED (test suite red for unrelated pre-existing reason, §J) |
| **Existing endpoint** | yes | yes | yes | yes | yes |
| **Proposed endpoint if missing** | — (proposed: filters + analytics in §F.3/F.4) | — | — | — | — |
| **Controller** | `WorkerEarningsController.list` (`earnings.controller.ts:41`) | `WorkersController.update` (`workers.controller.ts:74`) | `WorkersController.submit` | `WorkerOnboardingController.get` (`worker-onboarding.controller.ts:92`) | `AdminEarningsController.record` (`earnings.controller.ts:71`) |
| **Service** | `EarningsService.listForWorker` (`earnings.service.ts:127`) | `WorkersService.updateMyProfile` (`workers.service.ts:273`) | `WorkersService.submit` (`workers.service.ts:346`) | `WorkersService` + `VerificationService` (injected, `worker-onboarding.controller.ts:87-90`) | `EarningsService.record` (`earnings.service.ts:53`) |
| **Authentication** | Bearer access token | Bearer | Bearer | Bearer | Bearer |
| **Role** | `@RequireUserType('WORKER')` (`:26`) | `@RequireUserType('WORKER')` (`:48`) | `@RequireUserType('WORKER')` | `@RequireUserType('WORKER')` (`:84`) | `@RequireUserType('ADMIN')` (`:53`) |
| **Permission** | none beyond role | none beyond role | none beyond role | none beyond role | `@Permissions(PAYMENT_MANAGE)` (`:64`) |
| **Request DTO** | `PageQueryDto {page?, limit?}` | `UpdateWorkerProfileDto` (all optional) | none (empty body) | none | `CreateWagePaymentDto` + optional `Idempotency-Key` header |
| **Response DTO** | `WorkerEarningsView` (`earnings.dto.ts:118`) | `WorkerProfileResponse` (`workers.dto.ts:377`) | `WorkerProfileResponse` | onboarding step view | `AdminWagePaymentView` (201) |
| **Validation** | `page≥1`, `limit` 1–100 (`pagination.ts:12`) | class-validator on each optional field; grouped objects replaced whole | — | — | `amountMinor` 1…1_000_000_000 int, `periodLabel` 1–40, `method` enum, `referenceText` ≤200, `bookingId` uuid |
| **Error codes** | 400 `VALIDATION_FAILED`, 401, 403, 429, 500, 503 | 400 `VALIDATION_FAILED`, 401, 403, 404 `WORKER_PROFILE_NOT_FOUND` (no profile yet, `requireRefByUserId` `workers.service.ts:277`) | 422 `PROFILE_INCOMPLETE`, 422 `PHOTO_REQUIRED` | 401, 403 | 409 `NO_WORKER_ASSIGNED` / `BOOKING_NOT_STARTED`, 404, 409 `WAGE_PAYMENT_ALREADY_CORRECTED` / `WAGE_PAYMENT_IS_VOID`, 400 |
| **Swagger status** | documented (`@ApiModelResponse`) | documented | documented | documented | documented; **committed `docs/openapi.json` stale overall (§B caveat)** |

---

## F. Missing Endpoint Contracts — **ALL OF THIS IS PROPOSED, NONE OF IT EXISTS**

> Every contract below is a *proposal*. Nothing here is available in the current release. Amounts must never be computed from `payments` (that is customer money) or from `pricing_guidance`.

### F.1 (PROPOSED) Wallet summary — blocked on ledger decisions

```
GET /api/v1/workers/me/wallet/summary      Authorization: Bearer  (WORKER)
```
```jsonc
// 200 PROPOSED
{
  "availableBalanceMinor": 0,     // earned + settled − reserved − paid out
  "pendingEarningsMinor": 0,      // credited but not yet releasable
  "totalEarningsMinor": 0,        // lifetime credited
  "totalPaidMinor": 0,            // settled to bank/UPI
  "currency": "INR",
  "updatedAt": "2026-11-05T…Z"
}
```
Validation/errors: 401, 403, 429, 500/503 (`ApiError`). **Prerequisite:** a wallet ledger table + a *credited* business event + a release rule (all three are open business questions, §H).

### F.2 (PROPOSED) Bank accounts

```
GET    /api/v1/workers/me/bank-accounts
POST   /api/v1/workers/me/bank-accounts
PUT    /api/v1/workers/me/bank-accounts/{accountId}
DELETE /api/v1/workers/me/bank-accounts/{accountId}
GET    /api/v1/workers/me/bank-accounts/{accountId}     // verification status
```
```jsonc
// POST/PUT request (PROPOSED)
{ "accountHolderName": "Ramesh Kumar", "bankName": "HDFC Bank",
  "accountNumber": "123456789012", "ifsc": "HDFC0000123", "isPrimary": true }
// 200 response (PROPOSED) — account number ALWAYS masked
{ "id": "uuid", "accountHolderName": "Ramesh Kumar", "bankName": "HDFC Bank",
  "accountNumberMasked": "XXXXXXXX7812", "ifsc": "HDFC0000123",
  "verificationStatus": "UNVERIFIED", "isPrimary": true, "createdAt": "…", "updatedAt": "…" }
```
Proposed error codes: `400 VALIDATION_FAILED` (IFSC regex `^[A-Za-z]{4}0[A-Za-z0-9]{6}$`, account number 9–18 digits), `404 BANK_ACCOUNT_NOT_FOUND`, `409 BANK_ACCOUNT_IN_USE_BY_PAYOUT`, `409 PRIMARY_ACCOUNT_REQUIRED`, `422 ACCOUNT_UNVERIFIED` (withdrawal against unverified account), `409 ACCOUNT_LIMIT_REACHED`.
**Blocked on:** verification provider choice (penny-drop/KYC vendor), whether an unverified account may be saved, max accounts per worker, deletion policy when a payout references the account — §H.

### F.3 (PROPOSED) Earnings analytics

```
GET /api/v1/workers/me/wallet/analytics?period=THIS_WEEK|THIS_MONTH|LAST_MONTH|ALL_TIME|CUSTOM&from=YYYY-MM-DD&to=YYYY-MM-DD
```
```jsonc
// 200 PROPOSED (shape as requested; currency from the ledger rows)
{ "period": "THIS_MONTH", "currency": "INR", "totalEarningsMinor": 0, "completedShifts": 0,
  "dailyBreakdown": [{ "date": "2026-11-01", "earningsMinor": 0, "shifts": 0 }],
  "categoryBreakdown": [{ "categoryCode": "HOUSE_MAID", "categoryName": "House Maid",
      "earningsMinor": 0, "shifts": 0, "earningsPercent": "0.00" }],
  "startDate": "2026-11-01", "endDate": "2026-11-30" }
```
Rules for the implementation: **category codes must come from `service_categories`** (the real codes are `HOUSE_MAID, DRIVER, COOK, BABYSITTER, ELDERLY_CARE_HELPER, CLEANING_HELPER` — the labels in the request, e.g. "House Cleaning"/"Child Supervision"/"Platform Incentive", are **not** backend categories and "Platform Incentive" has no data source); day boundaries must use the platform's single timezone (India) as the codebase already does (`src/common/time/india.ts`); "completed shift" must be defined from `attendance_records` (`PRESENT`/`LATE`) or `bookings.status = COMPLETED` — **a booking is not a shift and an opportunity is not a shift** (§H).

### F.4 (PROPOSED) Recent earnings / transactions

```
GET /api/v1/workers/me/wallet/transactions?page=&limit=&from=&to=&type=&status=
```
```jsonc
// 200 PROPOSED
{ "data": [ { "id": "uuid", "type": "WAGE_PAYMENT|PAYOUT|ADJUSTMENT|REVERSAL|INCENTIVE",
    "bookingId": "uuid|null", "serviceName": "House Maid", "locationLabel": "Kukatpally",
    "amountMinor": 0, "currency": "INR", "occurredAt": "…", "status": "…", "description": "…" } ],
  "meta": { "page": 1, "limit": 20, "total": 0 } }
```
Pagination must follow the repo convention (`page`/`limit` ≤100, `meta {page,limit,total}`, `src/common/pagination/pagination.ts`). **Privacy:** customer name/address must not be returned — the existing worker views already strip private fields (`earnings.controller` worker view omits `workerId`; search uses an explicit allow-list, `search.service.ts:405`).

### F.5 (PROPOSED) Withdrawals

```
POST /api/v1/workers/me/wallet/withdrawals        (Idempotency-Key header, @Idempotent())
{ "amountMinor": 500000, "bankAccountId": "uuid" }
GET  /api/v1/workers/me/wallet/withdrawals?page=&limit=&status=
POST /api/v1/workers/me/wallet/withdrawals/{id}/cancel
```
Proposed error codes: `422 INSUFFICIENT_BALANCE`, `422 BELOW_MINIMUM_WITHDRAWAL` / `422 ABOVE_MAXIMUM_WITHDRAWAL`, `422 ACCOUNT_UNVERIFIED`, `404 BANK_ACCOUNT_NOT_FOUND`, `409 WITHDRAWAL_ALREADY_PENDING`, `404 WITHDRAWAL_NOT_FOUND`, `409 WITHDRAWAL_NOT_CANCELLABLE`.
**Must-not-build-without:** a real balance ledger, verified-account policy, min/max limits, approval model, payout rail, and failed-payout restoration — all §H. Balance reservation must be a single row-locked transaction (the repo's existing pattern: `repository.lock(...)` inside `$transaction`, plus `@Idempotent()` for duplicate requests).

### F.6 (PROPOSED) Payout history

```
GET /api/v1/workers/me/wallet/payouts?page=&limit=
GET /api/v1/workers/me/wallet/payouts/{payoutId}
```
```jsonc
// 200 PROPOSED
{ "data": [ { "id": "uuid", "amountMinor": 0, "currency": "INR",
    "bankAccount": { "maskedNumber": "XXXXXXXX7812", "ifsc": "HDFC0000123", "bankName": "HDFC Bank" },
    "requestedAt": "…", "processedAt": "…|null", "status": "REQUESTED|PROCESSING|PAID|FAILED|CANCELLED",
    "failureReason": "…|null", "providerReference": "…|null" } ],
  "meta": { "page": 1, "limit": 20, "total": 0 } }
```
Ownership must be enforced in the service layer (pattern already proven: `listForWorker` scopes by `workerId` and the integration test asserts IDOR resistance).

### F.7 Auth, headers, error envelope (shared by all proposals)

- `Authorization: Bearer <accessToken>`; `@RequireUserType('WORKER')` for `/workers/me/**`.
- Optional `Idempotency-Key` (8–100 of `[A-Za-z0-9_.:-]`) on unsafe endpoints — existing interceptor `src/common/idempotency/idempotency.interceptor.ts:22`.
- Standard error body (`ApiError`): `{ code, message, details?: [{field, messages[]}], requestId }`; standard codes `VALIDATION_FAILED, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, RATE_LIMITED, INTERNAL_ERROR, SERVICE_UNAVAILABLE` + module codes.
- OpenAPI: every new operation needs a success schema, `500`/`503`, and `401`/`403` when secured — enforced by `test/integration/contract.openapi.int-spec.ts` (asserts >300 operations and zero undocumented responses), and `docs/openapi.json` must be regenerated.

---

## G. DOB and Gender Audit — stage by stage

| # | Stage | Endpoint / artifact | `dateOfBirth` today | `gender` today | Change needed |
|---|---|---|---|---|---|
| 1 | Worker registration/create | `POST /api/v1/workers/me` (`CreateWorkerProfileDto`, only `name`) | ❌ | ❌ | optional: add both to the create DTO (or keep them for `PATCH`) |
| 2 | Profile model | `WorkerProfile` `schema.prisma:384` | ❌ no column | ❌ no column | **additive migration**: `dateOfBirth` (`@db.Date`), `gender` (enum or string — §H) |
| 3 | Registration DTO | `UpdateWorkerProfileDto` `workers.dto.ts:155` | ❌ | ❌ | add optional `dateOfBirth?`, `gender?` |
| 4 | Update profile API | `PATCH /api/v1/workers/me` → `scalarUpdate` `workers.service.ts:935` | ❌ | ❌ | map the two fields in `scalarUpdate` |
| 5 | Draft save | same `PATCH` (partial semantics) | ❌ | ❌ | free once (3)+(4) exist |
| 6 | Draft retrieval | `GET /api/v1/workers/me` → `toProfileView` `workers.service.ts:878` | ❌ | ❌ | add to `WorkerProfileResponse` |
| 7 | Resume | `GET /api/v1/workers/me/onboarding` → `missingForSubmission` + `STEP_OF_MISSING` `worker-onboarding.controller.ts:22` | ❌ | ❌ | add mapping **only if** the business makes either field mandatory |
| 8 | Application submission | `POST /workers/me/submit` → `missingForSubmission` `workers.service.ts:860` | ❌ not checked | ❌ not checked | add to `own[]` only if mandatory is approved; otherwise submission is unaffected |
| 9 | Worker profile retrieval | `GET /api/v1/workers/me` | ❌ | ❌ | response DTO change |
| 10 | Admin worker profile | `GET/PATCH /admin/workers/{workerId}` (`AdminWorkerDetail extends WorkerProfileResponse`) | ❌ | ❌ | inherits automatically; `PATCH` already accepts `UpdateWorkerProfileDto` (assisted onboarding) |
| 11 | Worker profile update (admin) | `PATCH /admin/workers/{workerId}` (+ `If-Match`) | ❌ | ❌ | inherits (3)+(4) |
| 12 | Search / customer profile serialization | `GET /search/workers[/{id}]` | ❌ (correctly absent) | ❌ | **no change** — explicit allow-list (`search.service.ts:405`) means new fields cannot leak by accident; keep DOB/gender out of it |

**DOB validation status:** no future-date check exists (no field), no minimum-age rule exists anywhere in code or docs (grep across `docs/` for "minimum age / 18 years / age requirement" → no domain hits). **Do not invent an age restriction — this is an open business question (§H).** Recommended technical shape when approved: store a calendar date (`@db.Date`, no time component ⇒ timezone-independent), validate `dateOfBirth <= today` in India time (the platform's single timezone), and keep the age comparison as a plain calendar-day arithmetic.

**Gender validation status:** no field, no enum, no accepted values anywhere. The suggested set (`MALE/FEMALE/OTHER/PREFER_NOT_TO_SAY`) is **not approved** — adding a Prisma enum requires a migration and enum values cannot be added casually to existing rows, so the value list must be confirmed before the first migration (§H).

**Retention guarantees once added:** draft save/resume/submission all operate on the same `WorkerProfile` row, so both fields survive `DRAFT → SUBMITTED` automatically (submission only flips `onboardingStatus`, `workers.service.ts:346-388`).

---

## H. Business Questions (cannot be answered from source code)

| # | Question | Why the code cannot answer it |
|---|---|---|
| H-1 | **Does SevaNest ever pay workers, and if so when does money become "earned"?** (booking started / completed / customer confirmation / attendance approved / off-platform) | `Q-73` in `OPEN_QUESTIONS.md:112` is still open; `D-102` records "zero escrow/payout in V1". The earnings module's own doc says "V1 is not payroll". |
| H-2 | **If a wallet is built: credit event, release/hold period, pending vs available, minimum/maximum withdrawal, fees, payout rail (bank transfer/UPI/NEFT), manual vs automatic approval, TAT, failed-payout retry and balance restoration** | none of it exists; inventing any of it would fabricate financial policy |
| H-3 | **Bank-account verification policy** — provider (penny-drop/KYC vendor), may an unverified account be saved, may it be selected for withdrawal, max accounts, can an account referenced by a payout be deleted, is KYC (PAN/Aadhaar) required first | no `BankAccount` model or provider interface exists |
| H-4 | **Is `dateOfBirth` required or optional for registration?** | not in any spec/doc in the repo |
| H-5 | **Minimum age for a worker** (and who enforces it) | no rule anywhere; must not be invented |
| H-6 | **Approved `gender` value list** (and whether it is optional / "prefer not to say" included) | no enum, no spec text in the repo |
| H-7 | **Category labels for analytics** — the request's labels ("House Cleaning", "Cooking & Meal Prep", "Family Driver", "Child Supervision", "Platform Incentive") do not match the seeded catalogue (`HOUSE_MAID, COOK, DRIVER, BABYSITTER, ELDERLY_CARE_HELPER, CLEANING_HELPER`), and **"Platform Incentive" has no data source** | `service_categories` is admin-managed master data |
| H-8 | **What counts as a "completed shift"** for analytics (attendance `PRESENT`/`LATE` day vs `bookings.status = COMPLETED`) | both exist; the business has not chosen |
| H-9 | Should **DOB/gender be visible to admins** (and to verification staff), and are they personal data under retention/erasure rules? | retention module exists but has no rule for these fields |

---

## I. Implementation Plan (for the approval round — nothing built yet)

### Track 1 — Registration: DOB + Gender (small, independent, no financial risk)

**Prerequisites:** H-4, H-5, H-6 answered.

| Step | File | Change |
|---|---|---|
| 1 | `prisma/migrations/2026xxxx_add_worker_dob_gender/` (new) | additive: `ALTER TABLE worker_profiles ADD COLUMN date_of_birth DATE NULL;` + `CREATE TYPE gender AS ENUM (...)` (or `TEXT` + CHECK if the business wants to add values later without a migration) |
| 2 | `prisma/schema.prisma` | two nullable fields on `WorkerProfile` with doc comments |
| 3 | `src/modules/workers/dto/workers.dto.ts` | `dateOfBirth?` (`@IsDateString()`/regex `YYYY-MM-DD`, not in the future), `gender?` (`@IsEnum`), on `UpdateWorkerProfileDto` (+ `CreateWorkerProfileDto`/`AdminCreateWorkerDto` if the business wants them at create); add both to `WorkerProfileResponse` |
| 4 | `src/modules/workers/workers.service.ts` | `scalarUpdate()` mapping; `toProfileView()` output; **only if required**: `missingForSubmission()` entries |
| 5 | `src/modules/verification/worker-onboarding.controller.ts` | `STEP_OF_MISSING` mapping to `PROFILE` **only if** the field becomes mandatory |
| 6 | `docs/openapi.json` | regenerate |
| 7 | tests | see §I-tests |

No new endpoint, no new module, no change to auth, no change to search cards (allow-list protects them).

### Track 2 — Earnings history & analytics (reporting only, **no ledger**)

Safe because it reads existing `worker_payment_references` (+ `attendance_records`/`bookings` for shift counts).
New module `src/modules/wallet/` **or** extend `src/modules/earnings/` (prefer extending: it already owns the worker money read path and the `payment.*` permissions):
- `GET /workers/me/earnings` → add optional `from`/`to`/`type` filters (keep response shape additive).
- New `GET /workers/me/earnings/analytics` (period + custom range, daily + category breakdown from `ServiceCategory`, percentages computed server-side in integer math).
- Tests: period boundaries (week/month/last-month/custom, India timezone), empty period, category percentages sum, IDOR, pagination caps.

### Track 3 — Wallet ledger + bank accounts + withdrawals + payouts (**new financial subsystem**)

Only after H-1…H-3 are decided. Suggested order:
1. Schema (all additive): `worker_bank_accounts` (encrypted `account_number`, IFSC, `verification_status`, `is_primary`, unique `(workerId)` partial primary), `wallet_accounts` or derived balance, `wallet_entries` (append-only, `Int` minor units, `entry_kind`, `reference_type/id`, unique `(referenceType, referenceId, entryKind)` to make duplicate credit impossible), `withdrawal_requests`, `payouts` (`provider_reference`, `failure_reason`, status machine).
2. Module `src/modules/wallet/` (controller/service/repository/DTO/README) following `earnings` module conventions; reuse `AuditService`, `@Idempotent()`, `DomainException`, `PageQueryDto`, `RequireUserType('WORKER')`, redaction (`account_number`/`ifsc` are already in the redaction regex, `src/common/audit/audit.service.ts:9`).
3. Balance computation = sum of entries in one transaction with `SELECT … FOR UPDATE` (repo pattern: `repository.lock`), never a cached column updated outside the transaction.
4. Provider integration (`src/integrations/payments/` already defines the provider interface pattern) + authenticated callbacks + dedupe by unique provider event id (mirror `PaymentEvent`).
5. Admin review endpoints with `payment.view` / `payment.manage` (and a decision on whether a new permission code is needed — role↔permission mapping is itself open, Q-11).
6. OpenAPI regeneration + contract test.

**Dependency rule:** Track 1 and Track 2 are independent of Track 3. Track 3 must not ship a "withdrawable balance" until the ledger + credit event + payout rail decisions exist.

### Test cases to add (per capability)

| Area | Tests |
|---|---|
| DOB | accepts `YYYY-MM-DD`; rejects future date; rejects garbage; optional vs required per decision; survives `PATCH` → `GET` → `submit` → admin `GET`; age rule (if approved) boundary; not present in `GET /search/workers` |
| Gender | enum acceptance/rejection; nullable; survives draft save/resume/submit; not exposed to customers |
| Draft | `PATCH` partial save keeps other fields; `GET /workers/me/onboarding` shows the new missing field only if mandatory |
| Wallet summary | sums from entries, currency, `updatedAt`, IDOR |
| Bank accounts | CRUD ownership (404 for another worker's id), IFSC/account validation, masking in **every** response, single primary invariant, delete blocked while a payout references it, audit redaction |
| Analytics | each period, custom range, day bucketing in IST, empty period, category percentages, no-op for zero rows |
| Transactions | pagination caps, date/type/status filters, privacy (no customer PII), immutability |
| Withdrawals | insufficient balance, below/above limits, unverified account, duplicate pending, `Idempotency-Key` replay, **concurrent withdrawals cannot overdraw** (row lock), cancel, failed payout restores balance |
| Payouts | ownership, status transitions, provider reference persisted, failure reason, callback auth + duplicate callback |

---

## J. Test Evidence (commands actually run in this session)

| Command | Result |
|---|---|
| `npm run typecheck` | **exit 0**, 0 errors |
| `npm run lint` | **exit 0**, 0 errors, 3 pre-existing warnings in `test/perf/perf-journeys.perf-spec.ts` (file not touched) |
| `npm run format:check` | **exit 0**, "All matched files use Prettier code style!" |
| `npm test` (unit) | **exit 0** — `Test Suites: 1 skipped, 54 passed, 54 of 55 total` · `Tests: 8 skipped, 525 passed, 533 total` (26.6 s) |
| `npm run test:e2e` | **exit 0** — `Test Suites: 2 passed, 2 total` · `Tests: 27 passed, 27 total` (16.4 s) |
| `npm run test:integration -- workers.api.int-spec.ts` (DB `sevanest_walletaudit_ci`) | **exit 0** — `1 passed, 1 suite` · `59 passed, 59 total` |
| `npm run test:integration -- onboarding.int-spec.ts` (same DB) | **exit 0** — `1 passed, 1 suite` · `8 passed, 8 total` |
| `npm run test:integration -- earnings.api.int-spec.ts` (same DB) | **exit 1** — `0 passed, 5 failed, 5 total` — see pre-existing failure below |
| `docker exec … psql` schema probes | `service_categories` seeded with the 6 real codes; `worker_profiles` has **no** `gender`/`date_of_birth`; **0** tables matching `wallet/bank/payout/withdraw` |
| `npm run typecheck` (re-run at report finalization, on the current tree incl. the new booking/interview edits) | **exit 0**, 0 errors |

**Environment note (read-only compliance):** no migration was created and **no migration was run against any shared/remote database**. `.env`'s `DATABASE_URL` points at a remote Supabase instance and was **not used**. The pre-existing local test DBs were stale (`sevanest_test` has 7 of 46 migrations), so a **new disposable local database** `sevanest_walletaudit_ci` was created in the local docker PostgreSQL and the **existing** migrations were applied to it (`npx prisma migrate deploy` with `DATABASE_URL` overridden to that local DB, exit 0) purely to run the integration suites.

**Working-tree state:** at audit start the tree was `M .gitignore` + 3 untracked `scripts/*` files. **During report finalization, additional uncommitted changes appeared under `src/modules/booking/` (controller, service, DTOs — worker interview `accept/decline/propose` actions) that this audit did NOT make and that kept growing while this report was written**; they are unrelated to wallet/registration/earnings and were **preserved untouched** (nothing staged, committed, or reverted — `git diff --cached` empty at finalization). All pre-existing changes remain as found.

**Pre-existing failure (not introduced by this audit, not fixed here — read-only):** `test/integration/earnings.api.int-spec.ts` fails 5/5 because `test/support/bookings.ts:41-48` (`makeBooking`) still posts a `HOUSE_MAID` booking **without `addressId`**, while `booking.service.ts:232` now rejects home-service bookings without an address (`422 ADDRESS_REQUIRED`, commit `89e38fc` / D-99). So **the only integration suite covering the worker money endpoint does not currently pass on `main`.**

**Existing tests by area (what exists vs what is missing):**

| Area | Existing | Missing |
|---|---|---|
| Worker wallet endpoints | — | everything |
| Bank account ownership / masking / verification | — | everything |
| Earnings aggregation, period filtering | — | everything |
| Earnings record/correct/void, worker read, IDOR, append-only | `earnings.api.int-spec.ts` (5 tests, currently red for the unrelated reason above) | unit spec for `EarningsService` (none exists) |
| Transaction pagination | page/limit asserted in the same suite | date/type/status filters |
| Withdrawal / insufficient balance / duplicate / concurrent | — | everything |
| Payout history ownership | — | everything |
| DOB validation, gender enum | — | everything |
| Draft persistence / resume / submission | `workers.api.int-spec.ts` (59/59 ✔), `onboarding.int-spec.ts` (8/8 ✔) | cases for the two new fields |
| OpenAPI contract parity | `contract.openapi.int-spec.ts` (not re-run this session — **NOT VERIFIED** here) | new operations must satisfy it |

**Not verified in this session:** full integration suite (only 3 of ~100 suites run), `npm run test:cov`, the live `/docs/openapi.json` against a running server, real Razorpay/verification vendors (fakes only, per repo docs), and anything wallet/bank/payout-related (nothing exists to verify).

---

## K. Final Recommendation (per requested feature)

| Feature | Classification |
|---|---|
| Worker wallet summary | **3. Not implemented — new development required**, and blocked behind H-1/H-2 (no balance exists to summarize) |
| Bank account management + verification status | **3. Not implemented — new development required**, blocked behind H-3 (verification provider/policy) |
| Earnings analytics (periods, daily, category) | **3. Not implemented** — buildable as *reporting only* on existing rows once H-7/H-8 are answered |
| Recent earnings / transaction history | **2. Existing but incomplete — targeted enhancement** (`GET /workers/me/earnings` exists; needs date/type/status filters and, if a ledger arrives, a real transaction list) |
| Withdrawal requests | **3. Not implemented** — **must not** be built until a ledger, verified-account policy and payout rail exist |
| Payout history & tracking | **3. Not implemented** — same prerequisite |
| "Is money wallet/escrow/withdrawable today?" | **4. Blocked by business clarification (Q-73 / H-1 / H-2)** — answer today is **no**, and only "recorded off-platform wage payments" may be displayed |
| Registration `dateOfBirth` | **3. Not implemented** — small additive change; blocked on H-4/H-5 (required? min age?) |
| Registration `gender` | **4. Blocked by business clarification (H-6)** — the enum list must be approved before the first migration; then it is a small additive change |
| Draft persistence / resume for DOB & gender | **1. Already available mechanism — no new endpoint required**; the fields ride the existing `PATCH /workers/me` → `GET /workers/me` → `POST /workers/me/submit` → `GET /workers/me/onboarding` flow once added |

**Single highest-value fix available right now (small, non-financial):** repair `test/support/bookings.ts` so `makeBooking` passes a customer `addressId`, restoring the green state of `earnings.api.int-spec.ts` and every other suite that builds bookings — this is a test-only repair and needs its own explicit task approval (it was out of scope for this read-only audit).

---

## L. Security Audit (spec §12)

All claims below were re-verified against source in this session. "N/A" means the subsystem does not exist — the property cannot be violated *today*, but must be designed in before any wallet/bank/payout code ships.

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Worker accesses only their own wallet/earnings | **Enforced for existing earnings; wallet N/A** | `earnings.controller.ts:41-46` derives `workerId` from the token (`requireRefByUserId`), never from the query; `earnings.repository.ts:93` scopes `where = { workerId, …COUNTED }`; IDOR resistance asserted in `workers.api.int-spec.ts` (59/59 ✔) |
| 2 | Worker cannot read another worker's bank accounts | **N/A — no bank-account endpoints or tables exist** | §B.3 |
| 3 | Worker cannot access another worker's payout | **N/A — no payout records exist** | §B.3 |
| 4 | Bank account numbers masked in responses | **N/A — but the audit-redaction layer already covers `account_number` and `ifsc`** for any future audit metadata (`audit.service.ts:9`); the §F.2 proposal mandates `accountNumberMasked` in every response | `src/common/audit/audit.service.ts:9` |
| 5 | Sensitive data not logged | **IMPLEMENTED for the existing surface** — `redactSensitive` runs on audit write (`audit.service.ts:95`) and again on read (`:59-85`), so rows written under older rules stay safe | `audit.service.ts:9,25-46,95` |
| 6 | Financial operations idempotent | **Pattern exists and is used** — `@Idempotent()` interceptor on all wage-payment writes; `Idempotency-Key` accepted (8–100 of `[A-Za-z0-9_.:-]`) | `idempotency.interceptor.ts`, `earnings.controller.ts:61,78,95` |
| 7 | Decimal-safe arithmetic | **IMPLEMENTED** — every money column is integer minor units (`amountMinor Int` on `Payment`, `FeeConfig`, `WorkerPaymentReference`); no floats anywhere | `schema.prisma:844,831,1601` |
| 8 | Balance updates atomic | **N/A (no balance)** — the required pattern is proven repo-wide: `SELECT … FOR UPDATE` inside `$transaction` | `workers.repository.ts:205-208`, `booking.repository.ts:227-230`, `attendance.repository.ts:93-96`, `verification.repository.ts:175-178` |
| 9 | Concurrent withdrawals cannot overdraw | **N/A — must be a designed invariant** (single row-locked transaction reserving balance + `@Idempotent()`), not an afterthought | proposed in §F.5; no code exists |
| 10 | Payout processing auditable | **N/A** — `AuditService` + append-only DB trigger (blocks UPDATE/DELETE on wage rows, proven by test) is the pattern to reuse | `worker_payment_references` trigger, `earnings.api.int-spec.ts` |
| 11 | Provider callbacks authenticated | **IMPLEMENTED for payments** — HMAC-SHA256 over raw body with constant-time compare | `razorpay-payment.provider.ts:328,334` (`createHmac` + `timingSafeEqual`) |
| 12 | Duplicate provider callbacks safe | **IMPLEMENTED for payments** — unique `providerEventId` on `PaymentEvent` (webhook dedupe) | `schema.prisma:894` |

### Security gaps found

- **G-1 (structural):** the entire worker-money *security* surface for wallet/bank/payout is absent because the subsystem is absent. No vulnerability today; every row-9/11/12-style property above is a **pre-shipment requirement** for Track 3 (§I).
- **G-2 (latent, minor):** `totals.currency` is hard-coded `'INR'` in `earnings.service.ts:136` while rows store their own `currency`. Any non-INR row would be mislabelled in the total. Existing data is INR-only, so no live defect — flag for the Track 2 change.
- **G-3 (process):** committed `docs/openapi.json` is stale (§B caveat) — a security/contract review performed against the file would miss live routes (`/notifications/test-push`, `/notifications/{id}/ack`). Review the live `GET /docs/openapi.json` or regenerate.
- **G-4 (coverage):** the only integration suite exercising the worker money endpoint (`earnings.api.int-spec.ts`, including its append-only and ownership assertions) is currently **red on `main`** for the unrelated `makeBooking` reason (§J) — its security assertions are not being enforced by CI right now.

**Not audited (out of scope / not verifiable here):** dependency/CVE scanning, auth-token issuance & rotation internals, rate-limit configuration values, infrastructure/network exposure, and any real third-party bank/KYC integration (none exists).
