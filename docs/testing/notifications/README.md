# Notifications - test results

**Result: PASS** - 13/13 tests passed, 0 failed (1 suite). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| integration | `notifications.api.int-spec.ts` | 13 | 0 |

## Other verification

- Run with in-memory SMS, push and WhatsApp adapters and the real BullMQ queue on Redis. Covered: template administration, outbox -> queued notifications -> queue jobs (job id = notification id), delivery through each adapter with rendered text, repeat and parallel delivery sending once, transient failure retried and permanent failure recorded without provider text, skipped deliveries, rollback leaving no event, stale re-queue, the queue processor, and the events produced by booking, payment and verification.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| notifications.api › templates (admin) | 2 | 0 |
| notifications.api › outbox, queue and delivery | 10 | 0 |
| notifications.api › events from the other modules | 1 | 0 |

## Every test and its result

### `notifications.api.int-spec.ts`

- PASS - templates (admin) › are managed by authorised staff only
- PASS - templates (admin) › validate the event, the channel and the placeholders, and refuse duplicates
- PASS - outbox, queue and delivery › turns a committed business event into one queued notification per configured channel, once
- PASS - outbox, queue and delivery › delivers through each adapter with the rendered text, and a repeat sends nothing more
- PASS - outbox, queue and delivery › sends once even when delivery is attempted in parallel and dispatch runs concurrently
- PASS - outbox, queue and delivery › retries a provider outage with the queue, fails after the last attempt, and hides the provider message
- PASS - outbox, queue and delivery › fails at once on a permanent provider rejection, and recovers by retry after a transient one
- PASS - outbox, queue and delivery › skips instead of failing when there is nobody to deliver to
- PASS - outbox, queue and delivery › queues nothing for an event no template covers, but still marks the event processed
- PASS - outbox, queue and delivery › records an event only if the business transaction commits
- PASS - outbox, queue and delivery › hands a stale queued notification back to the queue without creating a second job
- PASS - outbox, queue and delivery › is driven by the queue consumer: the processor delivers and reports the attempt number
- PASS - events from the other modules › are produced by booking, payment and verification transitions

## Not covered

- Real FCM / SMS / WhatsApp vendors and credentials (Q-08); the worker process loop was exercised through its service calls, not as a separate OS process.
