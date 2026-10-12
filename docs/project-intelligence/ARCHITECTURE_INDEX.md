# ARCHITECTURE_INDEX

Authority: BEA is the backend architecture (status: recommended, not client-approved). CFA/WFA are the Flutter
architectures (many items "Proposed"). No Admin-web (React) architecture document exists (GAP G-01).

## Backend (BEA)
- Style: NestJS+TypeScript **modular monolith**, 12 official PRD §11.1 components (BEA names 21 finer implementation domains inside them; see MODULE_MAP.md), one API process + BullMQ worker process (same codebase, separate container). BEA p1,p3.
- Layering per module: Controller → Service (txn orchestration) → Domain (rules/state machines) → Repository (only Prisma user). BEA p3.
- Boundary rule: modules interact via exported services + domain events; never read another module's tables. BEA p3.
- API: REST/JSON `/api/v1`, bearer JWT, DTO validation (unknown fields stripped), one error envelope {code,message,details,requestId}, X-Request-Id, page+limit+meta, filter/sort, Idempotency-Key on booking+payment create, OpenAPI from DTOs. BEA p2.
- Request chain: Gateway(TLS, rate limit, request id) → JwtAuthGuard → RolesGuard → PermissionsGuard(`@Permissions('x.y')`) → ValidationPipe → controller → service. BEA p2,p5.
- Data: PostgreSQL source of truth; Prisma; reviewed SQL migrations via CI/CD; append-only status-history + audit; unique provider event IDs; PITR backups. BEA p4. Redis ephemeral only (OTP counters, throttle, cache, locks, BullMQ) — never authoritative booking/payment/KYC. BEA p8.
- Auth: OTP hashed+expiring+attempt cap in Redis; access JWT ~15 min (suggested); opaque refresh token hashed in `sessions`, rotated each use; one session row per device; logout revokes session + FCM token; argon2/bcrypt for admin pwd; progressive lockout. BEA p5.
- Payments: create CREATED row → provider adapter → client SDK; client "paid" is a hint only; authoritative = signed webhook (raw body, HMAC) + server-side verify; unique provider_event_id in webhook_events; append-only payment_events; state CREATED→PENDING→SUCCESS|FAILED, refunds REFUND_PENDING→REFUNDED|PARTIALLY_REFUNDED|REFUND_FAILED; scheduled reconciliation. BEA p7.
- Async: queues notifications/payments/reports/reminders/verification; ~5 attempts, 2s doubling + jitter, dead-letter + replay, idempotent handlers; notify only after commit. BEA p6,p8.
- Adapters (interfaces): PaymentProvider(Razorpay/Cashfree/PayU), SmsProvider(+WhatsApp), PushProvider(FCM), MapsProvider(Google/alt), VerificationProvider(partner+Manual), StorageProvider(S3/AzureBlob). BEA p9.
- KYC files: private bucket, no public ACL, short-lived signed URLs per request after permission check, every view/download/approve/reject audited, masked identifiers. BEA p9.
- Deploy: Docker image per release promoted dev→staging→UAT→prod, separate DB/secrets per env, ≥2 API instances behind LB, managed PG/Redis, secrets manager, JSON logs with request ID, liveness/readiness, error tracking. BEA p10.

## Flutter apps (CFA / WFA) — all stack picks "Proposed" except Flutter, FCM
Clean layers (presentation/domain/data) + core/shared, feature-first; Riverpod, go_router, dio, flutter_secure_storage, ARB/intl, Crashlytics; flavors dev/stage/prod; server is source of truth for booking/payment/attendance/verification; idempotency key on writes; no gateway secrets in app; Worker app: step wizard, resumable compressed upload queue, assisted mode (Proposed), no payments.
Shared packages between apps proposed (design system, API client, storage, l10n, notifications).

## Admin web (React): only structural wireframes (WIRE §8-9) + Figma Sites links. No architecture doc.

## Open architecture items
Cloud (AWS/Azure), payment/SMS/WhatsApp/maps vendors, verification partner, numeric perf/SLA, device/browser matrix,
admin auth mechanism detail, IaC tool, Node/NestJS/Prisma versions, monorepo vs multi-repo — see OPEN_QUESTIONS.md.
