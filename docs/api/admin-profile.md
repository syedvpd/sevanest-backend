# Admin Portal - My Account (staff profile) API handoff

Status: **IMPLEMENTED AND TESTED** (backend). This document is the frontend integration contract for the
signed-in administrator's own profile screen: read profile, edit name / e-mail / phone, and upload or replace the
profile photo.

Written 2026-11-06. Generated OpenAPI is the source of truth and is updated by the same change:
`GET /docs/openapi.json` (Swagger UI at `/docs`). Tag: `Admin - My profile`.

---

## 1. Ground rules

- Base URL: `https://<host>/api` + `/v1/...` (URI versioning). Every path below is already versioned.
- Auth: `Authorization: Bearer <accessToken>` on every request. Obtain it from
  `POST /api/v1/auth/admin/login` (`{ email, password }` -> `{ accessToken, refreshToken, tokenType, expiresIn, user }`).
- **There is no admin id in any path, query or body.** The server always uses the id from the access token. Adding
  an id does nothing (unknown fields are stripped), so the screen can never edit someone else's account.
- All routes require an admin token. A customer/worker token gets `403 FORBIDDEN`; no token gets `401 UNAUTHENTICATED`.
- Request and response bodies are JSON except the photo upload, which is `multipart/form-data`.
- Errors always use the standard envelope:

```json
{
  "code": "ADMIN_EMAIL_TAKEN",
  "message": "That e-mail address is already in use",
  "details": [{ "field": "email", "messages": ["already in use by another account"] }],
  "requestId": "..."
}
```

Branch on `code`, not on `message`.

---

## 2. `GET /api/v1/admin/me/profile`

Returns the signed-in admin's profile.

### Response `200`

```json
{
  "id": "01a1ab17-6f86-76bc-b3fc-b777af38e033",
  "fullName": "Priya Sharma",
  "email": "priya.sharma@example.com",
  "phoneNumber": "+919876543210",
  "role": "OPERATIONS_ADMIN",
  "roles": ["OPERATIONS_ADMIN"],
  "status": "ACTIVE",
  "photo": {
    "url": "https://storage.example/signed/card.webp?...",
    "largeUrl": "https://storage.example/signed/large.webp?...",
    "expiresAt": "2026-11-06T10:15:00.000Z",
    "cacheKey": "admin-photos/<userId>/<uuid>.card.webp"
  },
  "createdAt": "2026-10-01T09:00:00.000Z",
  "updatedAt": "2026-11-06T09:00:00.000Z"
}
```

Field notes:

| Field | Type | Meaning |
|---|---|---|
| `id` | string (uuid) | The authenticated admin's user id. |
| `fullName` | string \| null | `null` until the admin saves a name. |
| `email` | string \| null | Login identifier for the admin portal (lower-cased). |
| `phoneNumber` | string \| null | E.164 (`+91...`). Not an admin login factor. |
| `role` | string \| null | Primary role code (first of `roles`). Read-only here. |
| `roles` | string[] | Every role held. Read-only here. |
| `status` | `"ACTIVE"` \| `"SUSPENDED"` | Read-only here. |
| `photo` | object \| null | `null` when no photo was ever uploaded. |
| `photo.url` | string | Signed URL, **small square** WebP (320 px) for avatars/lists. |
| `photo.largeUrl` | string | Signed URL, **large** WebP (max 1080 px) for the profile header. |
| `photo.expiresAt` | ISO date | Both URLs stop working at this time. |
| `photo.cacheKey` | string | Changes whenever the photo is replaced; safe as a client cache key. |

The response never contains a password hash, permissions or storage keys.

`updatedAt` is the later of the account row and the profile row, so a name-only change still moves it.

---

## 3. `PATCH /api/v1/admin/me/profile`

Partial update. Send only the fields that changed; omitted fields keep their value.

### Request

```json
{ "fullName": "Priya Sharma", "email": "priya.sharma@example.com", "phoneNumber": "9876543210" }
```

| Field | Rules |
|---|---|
| `fullName` | 1-200 chars after trimming. Letters (any script), marks, spaces and `. ' -` only. Must start with a letter. Empty/whitespace-only is rejected. `null` is rejected (it does not clear the name). |
| `email` | Valid e-mail, 3-254 chars, trimmed and stored lower-cased. Must be unique across **all** users (admin, customer, worker). |
| `phoneNumber` | Indian mobile: 10 digits starting 6-9, optionally prefixed with `+91`, `91` or `0`. Stored as `+91XXXXXXXXXX`. Must be unique across all users. |

At least one field is required; `{}` returns `400 VALIDATION_FAILED`.

Other keys (`role`, `roles`, `status`, `password`, `userId`, ...) are silently stripped by global validation and
have no effect. Do not send them.

### Response `200`

The full profile object, identical in shape to `GET` (with fresh photo URLs).

### Important behaviour: e-mail change

- The e-mail **is** the admin's login identifier. The change is accepted immediately and is what the account must
  use at the next `POST /api/v1/auth/admin/login`.
- There is **no separate e-mail verification step** for admin accounts in this backend (see open question
  Q-140). The API does not send a verification mail and does not auto-verify anything.
- Current access tokens stay valid after the change (they are bound to the user id, not the e-mail), so the screen
  does not need to force a logout. If the product team later requires re-authentication on e-mail change, that is
  a backend change, not a client workaround.
- To avoid an admin locking themselves out, keep the entered address visible in the UI and echo the returned
  `email` in any success toast.

### Errors

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Bad/empty value, `null`, or no field supplied. `details[].field` names the field. |
| 401 | `UNAUTHENTICATED` | Missing/expired token. |
| 403 | `FORBIDDEN` | Non-admin token. |
| 409 | `ADMIN_EMAIL_TAKEN` | E-mail already used by another account. |
| 409 | `ADMIN_PHONE_TAKEN` | Phone already used by another account. |

A failed PATCH changes nothing (validated before the transaction; uniqueness conflicts roll it back).

---

## 4. `POST /api/v1/admin/me/profile-photo`

Uploads or replaces the profile photo. Responds `200` (not `201`) with the full updated profile object.

### Request

`Content-Type: multipart/form-data`, one field:

| Field | Type | Rules |
|---|---|---|
| `file` | binary | JPEG, PNG or WebP. Maximum size = `PROFILE_PHOTO_MAX_BYTES` (default **5 MB**). |

Example (browser):

```js
const form = new FormData();
form.append('file', file); // from <input type="file"> or a Blob
await fetch('/api/v1/admin/me/profile-photo', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` }, // do NOT set Content-Type manually
  body: form,
});
```

Notes:

- The filename and the client-declared MIME type are **not trusted**. The server reads the real bytes, so:
  - a non-image renamed to `.png` -> `422 ADMIN_PHOTO_TYPE_NOT_ALLOWED`;
  - a JPEG uploaded with `image/png` -> `422 ADMIN_PHOTO_CONTENT_MISMATCH`;
  - a truncated/corrupt image -> `422 ADMIN_PHOTO_CONTENT_MISMATCH` or `422 ADMIN_PHOTO_INVALID`.
- Images are re-encoded server-side to WebP renditions (EXIF/GPS/device metadata is stripped). The original upload
  is never stored.
- A replacement is atomic: if validation, the malware scan, storage or the database fails, the previous photo
  stays current and the newly written objects are discarded.
- The previous photo's objects are deleted after a successful replacement.

### Response `200`

Full `AdminProfileView` (same as `GET`), with `photo.cacheKey` changed to the new value. Client should use the
returned `url` / `largeUrl` directly and can bust its image cache using `cacheKey`.

### Errors

| Status | `code` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing/expired token. |
| 403 | `FORBIDDEN` | Non-admin token. |
| 413 | `PAYLOAD_TOO_LARGE` | File exceeds the configured limit (checked after the transport limit). |
| 422 | `ADMIN_PHOTO_REQUIRED` | No `file` part, or an empty file. |
| 422 | `ADMIN_PHOTO_TYPE_NOT_ALLOWED` | Real bytes are not JPEG/PNG/WebP. |
| 422 | `ADMIN_PHOTO_CONTENT_MISMATCH` | Declared type differs from the real type, or the file is truncated. |
| 422 | `ADMIN_PHOTO_INVALID` | The bytes look like an image but cannot be decoded. |
| 422 | `ADMIN_PHOTO_MALWARE_DETECTED` | The malware scanner rejected the file. |
| 503 | `ADMIN_PHOTO_NOT_CONFIGURED` | `PROFILE_PHOTO_MAX_BYTES` is unset on that environment (feature off). |
| 503 | `ADMIN_PHOTO_STORAGE_UNAVAILABLE` | Object storage is unreachable. The previous photo is kept. |

Client limits (recommended): reject > 5 MB before upload, and accept `image/jpeg,image/png,image/webp` in the file
picker. Still handle the 413/422 responses, since the server limit is configuration, not a constant.

---

## 5. Screen behaviour checklist

1. On screen open: `GET /me/profile`. Render `fullName ?? ""`, `email`, `phoneNumber`, `role`, `status`, and the
   avatar from `photo.url` (fall back to initials from `fullName`/`email`).
2. Save: `PATCH` with **only** changed fields. On `200`, replace local state with the response body (do not merge
   manually).
3. Photo: upload immediately on pick (or behind a Save button, either is fine). Use the response body to re-render.
4. Signed URLs expire (`photo.expiresAt`). On image `403`/expired, re-`GET` the profile; do not retry the old URL.
   Renditions themselves are immutable, so caching by `cacheKey` is safe.
5. Disable the Save button while a request is in flight, and map `details[].field` to the matching input on `400`.
6. Do not show UI for role/status/password changes on this screen; those are separate admin flows (`PATCH
   /api/v1/admin/users/{userId}/status`, `POST /api/v1/admin/account/password`).
7. Role / status are shown read-only; a `SUPPORT_EXECUTIVE` sees the same screen as a `SUPER_ADMIN` (no permission
   is required to read or edit one's own profile).

---

## 6. Quick reference

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/v1/admin/me/profile` | Read own profile | `200 AdminProfileView` |
| `PATCH` | `/api/v1/admin/me/profile` | Update name/e-mail/phone | `200 AdminProfileView` |
| `POST` | `/api/v1/admin/me/profile-photo` | Upload/replace photo (multipart `file`) | `200 AdminProfileView` |

Open questions that affect the UI (tracked in `docs/project-intelligence/OPEN_QUESTIONS.md`):

- **Q-140** - Admin e-mail change and verification: the platform has no e-mail-verification or OTP state for admin
  accounts, so a changed e-mail is effective immediately and is the new login identifier. If the client wants a
  verification mail, a "pending e-mail" state, or re-authentication before the change takes effect, that is a new
  backend workflow.
