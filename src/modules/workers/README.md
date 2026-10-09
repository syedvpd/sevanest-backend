# Workers

The worker profile / work profile built on an existing WORKER account: personal and contact details, experience,
languages, expected salary and the roles (service categories) a worker offers, with step-by-step saving and submission.

## Scope

- **Owns:** `worker_profiles`, `worker_skills`, `worker_languages`.
- **Does not own:** the account (Users), roles master (Service Categories), preferred areas / time windows / engagement
  preference (Availability), KYC and documents (future Verification), search/matching/booking (future).
- Photo upload has no storage integration yet: `worker_profiles.profile_photo_ref` exists but is set only by the server and is
  never returned (the API exposes `hasProfilePhoto`).

## Requirements covered

| ID                     | Requirement                              | Where                                                                  |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| FR-WON-001             | Worker registers by OTP                  | Auth creates the WORKER account; `POST /workers/me` starts the profile |
| FR-WON-004             | Address and emergency contact            | `address`, `emergencyContact`                                          |
| FR-WON-005             | Previous employer / reference (optional) | `previousEmployer`                                                     |
| FR-WON-006 / FM-04     | Short steps, progress saved              | partial `PATCH /workers/me`, `missingForSubmission`                    |
| FR-WON-007             | Assisted onboarding                      | `PATCH /admin/workers/{workerId}` (`worker.manage`)                    |
| FR-WP-001              | One or more roles                        | `PUT /workers/me/categories`                                           |
| FR-WP-002              | Experience and languages                 | `experienceMonths`, `languages`                                        |
| FR-WP-004              | Expected salary                          | `expectedSalary` (rupees, optional, positive)                          |
| FM-04 step 7           | Submit for verification                  | `POST /workers/me/submit`                                              |
| FR-ADM-005             | Admin views/manages worker profiles      | `/admin/workers`                                                       |
| FR-WD-007 / FR-SEC-004 | No identity data on profiles             | KYC absent; private fields only to owner and `worker.view`             |

## Domain model

`worker_profiles` (one per worker user, `name` required, all else nullable while onboarding; `onboarding_status` DRAFT or
SUBMITTED with `submitted_at`; grouped fields address / emergency contact / previous employer are all-or-none),
`worker_skills` (worker, category), `worker_languages` (worker, language code). Experience is stored as total months.

## APIs (`/api/v1`)

| Method | Path                                   | Requires        | Purpose                                                                                                             |
| ------ | -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| POST   | `/workers/me`                          | WORKER          | Start my profile `{ name }` (409 if it exists)                                                                      |
| GET    | `/workers/me`                          | WORKER          | My profile incl. `missingForSubmission`                                                                             |
| PATCH  | `/workers/me`                          | WORKER          | Save any subset of `name, experienceMonths, expectedSalary, languages, address, emergencyContact, previousEmployer` |
| PUT    | `/workers/me/categories`               | WORKER          | Replace my roles `{ categoryIds }`                                                                                  |
| POST   | `/workers/me/submit`                   | WORKER          | Submit; 422 `PROFILE_INCOMPLETE` lists what is missing; repeat is a no-op                                           |
| GET    | `/admin/workers`                       | `worker.view`   | Paginated list (mobile masked), filters `onboardingStatus`, `categoryId`, `mobile`                                  |
| GET    | `/admin/workers/{workerId}`            | `worker.view`   | Full profile incl. address and emergency contact                                                                    |
| PATCH  | `/admin/workers/{workerId}`            | `worker.manage` | Assisted edit                                                                                                       |
| PUT    | `/admin/workers/{workerId}/categories` | `worker.manage` | Assisted roles                                                                                                      |

Suspension is `PATCH /admin/users/{userId}/status` (Users).

## Validation and business rules

- Name: letters, marks, spaces and `. ' -`. Mobiles: valid Indian mobile, stored as E.164. Pincode: six digits. Languages: format check
  (+ optional `SUPPORTED_LANGUAGES` allow-list), at least one when sent, no duplicates. Experience 0-1200 months, salary > 0 with at
  most 2 decimals. Length and size caps are technical bounds, not product limits.
- Only the fields above are writable; status, submission time, photo reference and ownership are server-controlled and ignored.
- A nested group (address, emergency contact, previous employer) is replaced as a whole; `previousEmployer: null` clears it.
- New roles must be enabled categories; roles the worker already holds may stay if later disabled.
- **Submission requires:** address, emergency contact, at least one role, at least one language, experience (this module) plus
  preferred areas, time windows and engagement preference (Availability, contributed through `WorkerSubmissionRegistry`).
  Photo and KYC documents are NOT checked (no upload integration; Verification module).
- Profiles stay editable after submission and keep their status (open decision).

## Authorization

WORKER endpoints use `@RequireUserType('WORKER')` and are scoped to the authenticated user (no worker id in the path, so there is
nothing to tamper with). Admin endpoints need ADMIN plus the permission; `worker.manage` does not imply `worker.view`. Customers
cannot reach any worker endpoint. Private data (address, emergency contact, previous employer) is returned to the owner and to
`worker.view` only; list views mask the mobile.

## Concurrency, audit, performance

Every mutation locks the profile row (`FOR UPDATE`), so parallel steps and parallel role/language replacements serialise; creation
relies on the unique `user_id`. Audit: `worker.profile_create`, `worker.profile_update` (field names only), `worker.categories_set`
(added/removed ids), `worker.profile_submit`; admin edits record the admin as actor. Lists use one profile query (relations
included), one batched user lookup and one batched category lookup. Indexes: `(onboarding_status, created_at)`,
`worker_skills(category_id)` for "workers offering category X".

## Contract for future modules

`WorkersService.getContract(workerId)` returns `{ id, userId, name, onboardingStatus, experienceMonths, languages, categoryIds }`
with no private data; `findRefByUserId / requireRefByUserId / requireRefById` resolve a worker; `WorkerSubmissionRegistry` lets
later modules add submission requirements.

## Open decisions

Which personal details beyond name are required ("Personal Details" step); salary period and experience display unit; whether a
submitted profile is locked or re-reviewed after edits; the worker status model (conflict C-03) and verification gating;
customer-facing worker visibility and emergency-contact policy (Q-10/Q-16); photo upload flow; admin creation of worker accounts.
