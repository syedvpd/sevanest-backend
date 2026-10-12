# PROJECT_CONTEXT — SevaNest

Navigation/memory layer. NOT a replacement for `docs/project-specifications/`. Recover context here first.
Last updated: 2026-10-08 (foundation verified).

## Source abbreviations (all under `docs/project-specifications/`)
PRD=SevaNest_PRD.pdf · SRS=SevaNest_SRS.pdf · FRD=SevaNest_FRD.pdf · TRD=SevaNest_TRD.pdf ·
BEA=SevaNest_Backend_Architecture.pdf · CFA=SevaNest_Customer_App_Frontend_Architecture.pdf ·
WFA=SevaNest_Worker_App_Frontend_Architecture.pdf · WIRE=SevaNest_Wireframe_Documentation.pdf
Text extracts are NOT stored in repo (regenerate: `pdftotext -layout <pdf>`; Git-for-Windows ships it).

## What the product is (FACT: PRD §1, SRS §1)
SevaNest: household-workforce marketplace ("Verified Help. Trusted Homes."). Customers hire verified maids, drivers,
cooks, babysitters, elderly-care helpers, cleaning helpers. Launch: Hyderabad (pilot: HITEC City, Madhapur, Kondapur,
Gachibowli, Kukatpally — PRD §22). V1 = 16 weeks. Dev partner: VPD Technologies Pvt Ltd.
Clients: Customer app (Flutter), Worker app (Flutter), Admin web (React). One REST API `/api/v1` (BEA p1-2).
Core principle: trust/safety is highest risk — no worker shown "fully verified" until configured checks done AND approved
by an authorized ops user (PRD §9, FR-VER-009).

## Backend direction
- DECISION (user, 2026-10-07): backend = NestJS + TypeScript modular monolith per BEA (current implementation direction, user-approved; client approval not evidenced). Client sign-off NOT evidenced
  (BEA: "recommended… not presented as client-approved"; SRS §7/§14 item 9 leaves NestJS vs Spring Boot open).
- Stack per BEA: PostgreSQL+Prisma, Redis+BullMQ, private object storage (S3/Azure Blob adapters), FCM, provider adapters,
  Docker, GitHub Actions, AWS|Azure (open).
- The `governance/sevanest_backend_governance/` pack says Spring Boot/Java 21 + SQS + outbox. That is
  NOT a project source and contradicts BEA → ignore its stack claims (see DECISION_INDEX D-02, conflict C-01).

## Status of the source documents
All SRS/FRD are "1.0 – Draft for review and sign-off". No signed approval, M1 requirements-freeze record, or change log
exists in repo. Treat everything "(Proposed)" as unapproved.

## Repo reality (verified 2026-10-08)
Git repository (branch `main`, nothing committed). NestJS foundation exists and is verified (see CURRENT_STATE.md).
Layout and precedence: root `MAP.md`. Global governance pack: external/local, gitignored (D-11). Toolchain decision: DECISION_INDEX D-13.

## How to resume a session
1. Root `CLAUDE.md` (standing rule: recover state from git/filesystem/toolchain, do not reread everything), then `MAP.md`.
2. `CURRENT_STATE.md`, then the index relevant to the task. 3. Pull only the exact spec section cited. 4. Inspect affected code/tests.