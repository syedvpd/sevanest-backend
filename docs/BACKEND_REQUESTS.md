# BACKEND_REQUESTS — customer-app asks and their backend status

Contract: OpenAPI of 2026-10-13 plus the changes below. Details, schemas and examples: `docs/qa/customer-support-safety-notifications-api.md`.
Status words: **implemented** (built and tested in this change), **already supported** (existed, now verified/documented), **configuration required**, **blocked** (named decision or external dependency).

## Module 10 — support, safety, notifications, push (questions 45–54)

Evidence for every row: `test/integration/module10.support-safety-notifications.int-spec.ts` (13 tests), `src/integrations/notifications/fcm.provider.spec.ts`, `src/config/app-config.service.spec.ts`. Nothing was run against Firebase, a real device, or a live database.

### 45. FAQ and support contact
| Ask | Status |
|---|---|
| FAQ / help content | **Blocked on product input.** No approved FAQ content exists in `docs/project-specifications/`, and none is invented. No endpoint added. The app keeps showing no FAQ/search until the client supplies the content and says whether it is admin-managed data or fixed reference data. |
| `support.phone` / `support.email` in `GET /app-config` | **Already supported; configuration required.** Set `SUPPORT_CONTACT_PHONE` and `SUPPORT_CONTACT_EMAIL` in the API environment (owner: client/operations supplies the real values). Unset or blank answers `null`. Blank values are now treated as unset (new). Tests: unit (configured, trimmed, unset, blank) and integration (`null` by default). |

### 46. Ticket fields
| Ask | Status |
|---|---|
| `subject` | **Already supported** (optional, max 120, stored separately; D-73). |
| Photos / attachments (up to 3) | **Blocked.** There is no support-attachment storage, ownership model, completion check or retention rule; the only upload path is KYC documents, which must not be reused. Accepting a URL as "proof of an upload" is refused. Needs: decision on retention/visibility of ticket photos (new Q-107), then a purpose-built upload route. |
| Minimum description length | **Implemented:** 10 characters after trimming (max 4000 unchanged). 400 otherwise. Applies to workers too (same endpoint). |
| "Urgent" priority | **Not available to customers, by design.** Priority is `LOW/MEDIUM/HIGH`, set by staff only (Q-59 proposal). No SLA or automatic escalation is promised; `dueAt` exists only if `SUPPORT_SLA_HOURS_*` is configured. |
| Safety-category ticket prioritised message | **Not implemented, nothing to promise.** No category is treated specially; no auto-priority policy is approved. The app must not claim prioritisation. Safety incidents belong in `POST /safety/reports`, which alerts staff (CRITICAL for `SAFETY_CONCERN`). |
| Payment / replacement / interview links sent as the booking id | **Correct (verified).** Payments, replacements and interviews all belong to a booking; the ticket stores `bookingId` only, and the caller must be a party to it (else 404 `BOOKING_NOT_FOUND`). No other entity ids are accepted. |

### 47. Statuses
| Ask | Status |
|---|---|
| `ESCALATED` shown as "In progress" | **Correct.** ESCALATED = staff moved it up internally; it is still being worked, not resolved. `CLOSED` + `resolution` text is correct. |
| Stable `history[].type` list | **Implemented:** fixed set `CREATED, ASSIGNED, PRIORITY_SET, ESCALATED, CLOSED` (OpenAPI enum; test asserts the set). |
| "Waiting for you" / "Resolved" | **Not in the backend and not invented.** No approved workflow. CLOSED is the only resolved state. Product decision Q-108. |

### 48. Conversation
| Ask | Status |
|---|---|
| Order of `GET .../messages` | **Documented + tested:** oldest first, `createdAt` then `id` (deterministic tie-break). |
| Is `description` the first message? | **No (verified), documented.** `description` is on the ticket; the thread contains only real messages. The app should show `description` first and must not rely on matching message text. |
| Reopen a closed ticket | **Not allowed (already supported, documented).** CLOSED is final (409 `TICKET_CLOSED`, also for staff). The app creates a new ticket. Reopening needs a decision (Q-108). |

### 49. Safety report reasons
| Ask | Status |
|---|---|
| Arrived late / left early / attendance wrong / work quality | **Not added to `reasonCode`** (they are not safety reasons and mapping them to safety codes would mislead). They belong to attendance exceptions (`POST /attendance/bookings/{id}/exceptions`) or a support ticket. Codes stay `HARASSMENT, THEFT, SAFETY_CONCERN, MISCONDUCT, FRAUD, NO_SHOW, OTHER`. |
| `reason` vs `note` | **Implemented/clarified:** `note` (max 1000) = the reporter's account, staff-only, stored on the report. `reason` (max 500) = text kept with the block, used only when `alsoBlock: true` (previously silently ignored). The app should send `note`. |
| Idempotency | **Implemented:** `Idempotency-Key` honoured on `POST /safety/reports` and `POST /safety/blocks` (persisted store; concurrent retries create one report). |
| Ticket id in the response | **No ticket is created or linked** (the report is its own record; staff are alerted). The response `id` is the report id. |
| Blocked-workers list | **Already supported:** `GET /safety/blocks` (+ `DELETE /safety/blocks/{id}`); verified; shows only the worker reference. A staff-applied block cannot be lifted by the user (409 `BLOCK_ADMIN_APPLIED`). |

### 50. Naming the worker
**Implemented/verified.** A customer may send `workerId`, `bookingId` or both, for report and block. `bookingId` must be the customer's own booking with an assigned worker. If both are sent, the worker must be the one on that booking (new: otherwise 404 `SAFETY_TARGET_NOT_FOUND`, previously `workerId` was silently ignored).

### 51. Device token
| Ask | Status |
|---|---|
| Logout drops the bound token? | **Already supported (verified by test):** the token is bound to the session and removed with it; other devices keep theirs. |
| Per session or per user? | **Per session** (one token per session, a user has one per signed-in device; a token moves if re-bound elsewhere). |
| Unbind route | **Implemented:** `DELETE /auth/device-token` removes the current session's token only (idempotent, 204). |
| Token FCM reports invalid | **Implemented, tested with faked FCM only:** `UNREGISTERED`/404 and the "registration token" 400 are classified as dead; the binding is deleted; other devices still get the push; if none is left the notification is `SKIPPED` (`NO_VALID_DEVICE`). Other 4xx (bad payload, credentials) keep the token. **Not verified against Firebase.** |

### 52. Push payload and route types
**Implemented/documented.** FCM `data` (all strings): `notificationId`, `event`, and when the event names an entity `routeType` + `routeId` (previously the push carried no route). Inbox `route.type` is chosen by the first id the event carries, in the order `bookingId` → `ticketId` → `replacementId` → `paymentId`. Types actually emitted to customers/workers today: **`booking` and `ticket`** (or `null`). `replacement` and `payment` exist in the code but are **never emitted** for current events, because replacement and payment events also carry `bookingId`, which wins; `payment` appears only on the staff-only `PAYMENT_EXCEPTION_ALERT`, which has no inbox entry for customers. **`interview` is not emitted**: interview events carry `bookingId` (and `interviewId`, which is not routed) and route to `booking`. Changing this is a contract change for the app: product decision Q-110. **No rating prompt exists**: `RATING_RECEIVED` (to the worker) and `ATTENDANCE_EXCEPTION` are defined with default wording but nothing in the backend emits them. Event → route table: QA doc §6.

### 53. Unread count, preferences
| Ask | Status |
|---|---|
| Unread-count shape | **Implemented:** `{ "count": n, "unread": n }` (same value; `unread` kept for compatibility); typed in OpenAPI. Scoped to the caller's IN_APP, delivered, unread items. |
| Mark unread | **Implemented:** `POST /notifications/{id}/unread` (204, owner only, idempotent). |
| Delete inbox item | **Blocked:** retention/deletion policy undefined (Q-109). |
| Notification preferences | **Blocked:** no approved channel defaults or exemptions for transactional/safety messages (Q-109); storing them without enforcing in dispatch would be misleading, so none were added. |

### 54. Permission re-ask timing
**Client decision, not backend.** The 3-day interval exists nowhere in the backend (no config key, no stored prompt state). It stays a Flutter/product decision; no setting added. Push permission and token binding are independent of it: the app may call `PUT /auth/device-token` whenever it has a token.

### Not backend items (unchanged)
Firebase projects (`google-services.json`, `GoogleService-Info.plist`), the Android release keystore and iOS builds block verification of push on a real device. The backend needs `PUSH_PROVIDER=fcm` and `FCM_SERVICE_ACCOUNT_JSON` in the target environment. The local `.env` has both set, but this work deliberately did not send anything through Firebase, so FCM delivery, the real error codes for dead tokens and push on a device remain **unverified**.
