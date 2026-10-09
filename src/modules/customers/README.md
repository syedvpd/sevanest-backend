# Customers

Customer profile and saved addresses, plus admin customer management (view, status, notes).

## Requirements covered

| ID                     | Requirement                                                                                            | Where                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| FR-CUS-003/004/006     | Capture name, email, preferred language; a new customer creates a valid profile after OTP registration | `POST /customers/me`                         |
| FR-CUS-005             | Save multiple addresses                                                                                | `/customers/me/addresses`                    |
| FR-CUS-005 / FM-02     | One address can be marked default                                                                      | `PUT .../default`, `isDefault` on create     |
| FRD FM-02              | Mobile is verified by OTP and read-only                                                                | read from the authenticated account          |
| FRD FM-02              | Verification status visible to admin; admin can add notes, change status, suspend                      | `/admin/customers/...`; suspension via Users |
| FR-SEC-006             | Mask sensitive information in routine screens                                                          | admin list masks the mobile                  |
| FR-SEC-007, FR-SEC-008 | Suspension; audit of status changes                                                                    | Users; `customer.*` audit actions            |

## Domain model

- `customer_profiles`: one per customer user (`user_id` unique): `name`, `email`, `preferred_language`,
  `verification_status` (`PENDING` | `VERIFIED`). The mobile number is not copied; it stays on `users`.
- `customer_addresses`: `line`, `area`, `city`, `pincode`, optional `latitude`/`longitude`, `is_default`, `is_active`.
  Addresses are never hard-deleted (future bookings will reference them); removal sets `is_active = false`.
- `customer_notes`: append-only admin notes (`author_id`, `note`).

Database-enforced invariants (migration `20261008120000_auth_users_customers`): at most one default address per customer
(partial unique index), a default must be active (CHECK), coordinates are both set or both null and within range (CHECK).
Account suspension is `users.status`, owned by Users; the profile carries only the verification state.

## APIs (all under `/api/v1`)

Customer (user type CUSTOMER only; everything is scoped to the authenticated user, never to an id from the client):

| Method | Path                                          | Purpose                                                                   |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/customers/me`                               | Create my profile `{ name, email, preferredLanguage }` (409 if it exists) |
| GET    | `/customers/me`                               | My profile (404 `CUSTOMER_PROFILE_NOT_FOUND` until created)               |
| PATCH  | `/customers/me`                               | Update name, email and/or language (at least one)                         |
| GET    | `/customers/me/addresses`                     | My active addresses, default first                                        |
| POST   | `/customers/me/addresses`                     | Save an address; `isDefault: true` replaces the current default           |
| GET    | `/customers/me/addresses/{addressId}`         | One of my addresses                                                       |
| PATCH  | `/customers/me/addresses/{addressId}`         | Edit fields; `latitude`+`longitude` together, `null`/`null` clears        |
| PUT    | `/customers/me/addresses/{addressId}/default` | Make it the default (idempotent)                                          |
| DELETE | `/customers/me/addresses/{addressId}`         | Remove (soft)                                                             |

Admin (user type ADMIN plus permission):

| Method | Path                                                    | Permission        | Purpose                                                       |
| ------ | ------------------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| GET    | `/admin/customers?page&limit&verificationStatus&mobile` | `customer.view`   | Paginated list, mobile masked                                 |
| GET    | `/admin/customers/{customerId}`                         | `customer.view`   | Detail with all addresses (incl. inactive) and account status |
| PATCH  | `/admin/customers/{customerId}/verification-status`     | `customer.manage` | `{ status: PENDING\|VERIFIED, note? }`                        |
| POST   | `/admin/customers/{customerId}/notes`                   | `customer.manage` | Add a note                                                    |
| GET    | `/admin/customers/{customerId}/notes?page&limit`        | `customer.view`   | Notes, newest first                                           |

To suspend a customer use `PATCH /admin/users/{userId}/status` with the `userId` from the customer detail.

## Validation

Name: letters, marks, spaces and `. ' -`, 1-200 characters. Email: valid, lower-cased, at most 254. Preferred language: a
language code (`en`, `hi`, `en-IN`...); restricted to `SUPPORTED_LANGUAGES` when that allow-list is configured. Address:
`line` 1-500, `area` 1-200, `city` 1-100, `pincode` six digits not starting with 0, coordinates within range with at most
6 decimals. Lists accept `page >= 1` and `limit` 1-100. Length caps are technical bounds, not product limits. Only the
documented fields are writable; everything else is stripped, so status, mobile, ownership and `isActive` cannot be set by a client.

## Business rules

- A profile must exist before addresses can be managed (409 `CUSTOMER_PROFILE_REQUIRED`).
- The first address is not made default automatically, and removing the default leaves no default until the customer
  chooses one (the specification defines neither).
- A new profile is `PENDING`. Only an authorised admin changes it; there is no automatic promotion because the rule is undefined.
- Another customer's address id answers 404 `ADDRESS_NOT_FOUND`, identical to an unknown id, for every operation.
- A suspended customer is rejected (401) by the authentication guard on every customer endpoint.

## Error codes

`CUSTOMER_PROFILE_EXISTS`, `CUSTOMER_PROFILE_NOT_FOUND`, `CUSTOMER_PROFILE_REQUIRED`, `CUSTOMER_NOT_FOUND`, `ADDRESS_NOT_FOUND`, plus shared codes.

## Transactions and concurrency

Every address mutation runs in one transaction that first locks the customer's profile row, so parallel default changes,
parallel creations with `isDefault`, and edits all serialise per customer; the partial unique index is the backstop.
Profile creation relies on the unique `user_id`: parallel creates yield one 201 and the rest 409. Verification-status
changes lock the profile row, so parallel identical changes write one audit record. Admin lists run three queries
(profiles, count, one batched user lookup), with no per-row queries.

## Security

Ownership is part of every query (`customer_id` comes from the authenticated user's profile). The admin list masks the
mobile; the detail shows it in full for operations. Notes and personal values never enter the audit log: profile and address
audits record field names only, note audits record the note id.

## Audit

`customer.profile_create`, `customer.profile_update`, `customer.address_create`, `customer.address_update`,
`customer.address_set_default`, `customer.address_deactivate`, `customer.verification_status_change` (before/after + note),
`customer.note_add`.

## Known limitations and open decisions

- **Verification states and promotion rule.** The specification names only "pending" and a verified/active outcome and
  does not define when PENDING becomes VERIFIED. Today only an admin decides; no history table exists (the audit log keeps
  before/after). Additional states (e.g. rejected) are not invented.
- **Language catalogue and address limits are not specified.** Language is validated by format and optionally by an
  allow-list; there is no cap on the number of addresses.
- Default-address behaviour (auto-default, promotion after removal) is explicit-only, as noted above.
- Admin detail views are not individually audited.
- Customer deletion/erasure and data retention are not covered (retention policy is undefined).
