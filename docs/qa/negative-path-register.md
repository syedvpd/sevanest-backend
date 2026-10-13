# Negative-path register

Audit date 2026-10-12. "Tested" names the suite that proves it on a disposable local database. "Not tested" cases are open items, not passes. Real providers and multi-instance behaviour are not covered by any row.

| # | Area | Case | Result | Where |
|---|---|---|---|---|
| N-001 | Auth | Malformed / non-Indian mobile on OTP request | Tested (400) | auth.api |
| N-002 | Auth | Wrong, expired, reused OTP; attempts exhausted; lockout | Tested | auth.api |
| N-003 | Auth | Resend inside cooldown; send window cap; per-IP cap | Tested | auth.api |
| N-004 | Auth | Parallel verification of one OTP; parallel refresh; parallel failures | Tested | auth.api |
| N-004b | Auth | Concurrent FIRST login creating the account twice | Not confirmed by a dedicated test (code re-reads the winner on unique violation) | - |
| N-005 | Auth | Refresh token replay revokes the session | Tested | auth.api |
| N-006 | Auth | Suspended user with a live token | Tested (403 ACCOUNT_SUSPENDED) | users.api, foundation e2e |
| N-007 | Auth | SMS provider outage / rejection leaves no usable challenge | Tested with mocks | auth.api, sms-providers.spec |
| N-008 | Auth | Redis unavailable during OTP | Not tested end to end | - |
| N-009 | Auth | OTP present in logs/audit/responses | Tested | auth.api, qa.adversarial |
| N-010 | Auth | Spoofed X-Forwarded-For beyond trusted hops | Tested | remediation.throttle |
| N-011 | Admin | Login lockout and unknown-email timing | Tested | admin.api |
| N-012 | Admin | Reset of own password / of a non-admin / by non-Super Admin | Tested | small.items |
| N-013 | Customer | Mass assignment of status/ids on profile | Tested | customers.api, qa.adversarial |
| N-014 | Customer | Cross-customer address read/update/delete (404) | Tested | customers.api |
| N-015 | Customer | Two concurrent default-address changes | Tested | customers.api |
| N-016 | Customer | Self-promotion to VERIFIED | Tested (refused) | customers.api |
| N-017 | Customer | Auto-verification never overrides staff | Tested | small.items |
| N-018 | Discovery | Unknown sort field / limit above cap / page past end | Tested | search.api |
| N-019 | Discovery | Category/area disabled between search and booking | Tested | booking.api |
| N-020 | Discovery | Private worker fields in cards | Tested | search.api, qa.adversarial |
| N-021 | Booking | Past start date; reversed budget; note with markup | Tested | gap.closing |
| N-022 | Booking | Foreign address id; address in another city | Tested | gap.closing |
| N-023 | Booking | Idempotency replay with changed body | Tested | booking.api |
| N-024 | Booking | All 297 state x action x actor combinations | Tested | qa.statemachine |
| N-025 | Booking | Concurrent identical / conflicting transitions | Tested | qa.statemachine, qa.concurrency |
| N-026 | Booking | Start before agreed date | Tested | small.items |
| N-027 | Booking | Worker accept after reassignment or deadline | Partly tested | gap.closing |
| N-028 | Booking | Admin-created booking: unknown/suspended customer | Tested | small.items |
| N-029 | Payment | Wrong signature; amount mismatch; unknown order | Tested | payment.api, payments.recovery |
| N-030 | Payment | Duplicate / out-of-order / replayed webhook | Tested | payments.recovery |
| N-031 | Payment | Cancel racing a payment; late success after cancel | Tested | payments.recovery |
| N-032 | Payment | Lost webhook recovered by lookup; provider outage; exhaustion | Tested (fake gateway) | payments.recovery |
| N-033 | Payment | Refund twice; refund of unpaid | Tested | payment.api |
| N-034 | Payment | Real gateway timeouts / sandbox behaviour | Not tested | - |
| N-035 | Generic | Idempotency-Key: replay, reuse, concurrent, failed request, expiry, malformed | Tested | small.items |
| N-036 | Generic | Stale If-Match on worker and customer edits | Tested | small.items |
| N-037 | KYC | Spoofed MIME, markup, truncated, empty, oversize, missing object | Tested | kyc.integrity |
| N-038 | KYC | Hash changes between confirm and review | Tested | kyc.integrity |
| N-039 | KYC | Malware verdict, scanner outage | Tested with a fake scanner and fake clamd | small.items, malware-scanner.spec |
| N-040 | KYC | Real bucket permissions, signed URL expiry at the provider | Not tested | - |
| N-041 | Worker | Foreign document id / foreign booking | Tested | verification.api, attendance.api |
| N-042 | Worker | Photo write path, wrong type, replace while approved | Tested | modules.workforce |
| N-043 | Attendance | Duplicate day, backdated, non-active booking, foreign owner | Tested | attendance.api |
| N-044 | Attendance | Month summary: bad month, foreign owner | Tested | small.items |
| N-045 | Support | Foreign ticket, closed ticket, internal note leakage | Tested | support.api, gap.closing |
| N-046 | Ratings | Duplicate, ineligible booking, hidden review aggregate | Tested | ratings.api |
| N-047 | Replacement | Duplicate open request (parallel); ineligible; parallel selection | Tested | replacement.api, qa.concurrency |
| N-048 | Safety | Block hides the pair everywhere; duplicate report | Tested | gap.closing |
| N-049 | RBAC | Every admin route against missing permission / wrong type | Tested (route inventory) | qa.access, qa.inventory |
| N-050 | RBAC | KYC link without permission | Tested | verification.api |
| N-051 | Reports | Range over 366 days, bad dates, role limits, CSV formula injection | Tested | reports.api, small.items, csv.spec |
| N-052 | Jobs | Duplicate / concurrent recovery run; crash mid-run | Tested (claim queue) | payments.recovery |
| N-053 | Jobs | Booking sweep, SLA sweep run twice | Tested | gap.closing |
| N-054 | Jobs | Loops actually scheduled and deployed on Render | Not verified (live readiness showed 4 of 6) | - |
| N-055 | Notifications | Dead-letter after repeated failure; retry | Tested | remediation.notifications |
| N-056 | Config | Production refuses fake adapters / missing proxy hops | Tested | env.validation.spec |
| N-057 | DB | Migrations on an empty database, no schema drift | Verified (prisma migrate diff) | this audit |
| N-058 | Retention | Erasure, retention purge | Not implemented | - |
| N-059 | Infra | Backup restore, multi-instance, Redis outage reconnect | Not tested | - |
| N-060 | Browser/UI | Any screen, button or form | Not available | - |
| N-061 | Scheduling | Overlapping hours for a held worker (exact, partial, contained) | Tested (409 WORKER_UNAVAILABLE) | scheduling.int-spec |
| N-062 | Scheduling | Adjacent hour after the service ends; same hour another date; another worker | Tested (allowed) | scheduling.int-spec |
| N-063 | Scheduling | Busy worker hidden from search and matching only for the overlapping time; listed without a time | Tested | scheduling.int-spec |
| N-064 | Scheduling | Two customers confirm the same worker for overlapping times at the same moment | Tested (exactly one 200, one 409) | scheduling.int-spec |
| N-065 | Scheduling | Cancelling frees the worker again; unpaid held booking keeps the hold | Tested | scheduling.int-spec |
| N-066 | Scheduling | Recurring engagement busy on every later day | Tested | scheduling.int-spec |
| N-067 | Catalogue | Engagement not offered by the category: booking, search, matching (422); list validation; permission; audit | Tested | scheduling.int-spec |
| N-068 | Worker | Opportunity feed: other workers and customers see nothing; answered jobs leave | Tested | scheduling.int-spec |
| N-069 | Admin | Worker filters bad status / date (400); complaint history by creator | Tested | scheduling.int-spec |
| N-070 | Ops | Heartbeat lifetime follows a loop's interval | Verified by code reading; not unit-tested; live re-check pending | - |

| N-071 | Worker | References: duplicates, own number, more than five, bad mobile, missing body leave the list unchanged; staff read audited without personal data | Tested | remaining.int-spec |
| N-072 | Booking | Slot proposal: not scheduled (409), other worker (404), customer calling the worker route (403), past / unchanged / malformed time (400), foreign customer (404), accepted twice (409 NO_SLOT_PROPOSAL), cancelled booking clears it | Tested | remaining.int-spec |
| N-073 | Booking | Two answers to one proposal at the same moment | Tested (one 200, one 409) | remaining.int-spec |
| N-074 | Booking | Replacement chain: foreign customer 404, unknown 404, malformed id 400, customer on admin route 403, anonymous 401, worker ids hidden from the customer | Tested | remaining.int-spec |
| N-075 | Customer | Stale profile / address edit 412, parallel edits one winner, foreign address 404 | Tested | remaining.int-spec |
| N-076 | Admin | Stale category / area / template edit 412 | Tested | remaining.int-spec |
| N-077 | Scheduling | Travel buffer boundaries (exactly at the buffer free, one minute inside busy), search agrees with booking | Tested | scheduling.buffer.int-spec |
| N-078 | Scheduling | Confirm racing a cancellation + payment; three customers confirming one worker across the buffer | Tested | scheduling.buffer.int-spec |
| N-079 | Scheduling | Auto-cancel of an unpaid booking frees the worker; a failed payment keeps the hold | Tested | scheduling.buffer.int-spec |
| N-080 | Scheduling | Time zones: dates are India calendar dates (DATE columns, `indiaToday`); holds always carry a start date because confirmation requires one | Verified by code reading only; no boundary-time test at midnight IST | - |
