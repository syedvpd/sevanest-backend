# 02 — API contract audit

Evidence: `docs/openapi.json` (304 operations, parsed), runtime route dump (305 routes), `AllExceptionsFilter`, `createValidationPipe`, `PageQueryDto`, and the existing contract suites (`contract.openapi.int-spec`, `qa.adversarial`, `qa.robustness`, `security.api`). Not a sample: the OpenAPI figures below cover all 304 operations.

## Status

**VERIFIED.** Runtime validation, envelope and authorization are strong and tested. The documentation gaps found (no error responses, 19 untyped responses, one wrong decorator) were fixed in the second fix round and are now enforced by a contract test.

## A. Request validation (runtime, not just decorators)

| Check | Result | Evidence |
|---|---|---|
| Global `ValidationPipe`: `whitelist`, `transform`, `forbidUnknownValues`, no value echo, custom exception factory to the standard envelope with per-field messages | PASS | `src/common/pipes/validation.pipe.ts`; `qa.adversarial` |
| `forbidNonWhitelisted` | OFF by design: unknown fields are silently dropped, never rejected. A client typo is invisible. Not changed (would break lenient clients). | pipe config; `qa.adversarial` "never echoes a mass-assigned field" |
| Malformed ids on every id route | 400 (never 500/200) | `qa.adversarial`, `qa.robustness` (every route, every caller) |
| Traversal, null bytes, very long ids, SQL in query strings, prototype-pollution keys | treated as data | `qa.adversarial` |
| Oversized body | rejected before any handler (413 `PAYLOAD_TOO_LARGE`) | `security.api` |
| Pagination | `limit` has a `maximum` on all 51 GET operations that take it (100 ceiling); `page` huge values (up to 9007199254740993) answer 200 with an empty page on six admin lists, no 500 | OpenAPI scan; probe in Batch 3 |
| Array inputs | every array DTO in customers, workers, availability has `ArrayMaxSize` | Batch 2 scan |
| Unbounded list responses | `GET /customers/me/addresses` (bounded by the new cap of 20, F-005 fixed), `GET /safety/blocks` (F-001, open); the other unpaged GET lists are single objects, small fixed catalogues, or per-user capped sets (sessions, references) | OpenAPI + code |
| Exports | `payments-export` and `reports/export/*` capped at 5000 rows, answer 413 beyond; range at most 366 days; CSV cells neutralised against formulas | `payment.service.ts` `EXPORT_MAX_ROWS`, `reports.service.ts` `EXPORT_ROWS_MAX`, `csv.ts` |

## B. Response consistency (all 304 operations)

| Check | Count | Reading |
|---|---|---|
| Operations with a 2xx | 304 / 304 | ok |
| Success codes | GET 200 ×151; POST 201 ×37, POST 200 ×66, POST 204 ×5; PUT 200 ×17, PUT 204 ×2; PATCH 200 ×15; DELETE 204 ×9, DELETE 200 ×2 | POST 200 is used for actions and state changes (login, accept, cancel, confirm), 201 for creations. Consistent in intent. Four POSTs named like creations return 200 (`otp/request`, two `submit`, `verification notes`): these are requests/commands, not resource creations. No change recommended. |
| Bearer security declared | 295 / 304 (the 9 without are the public routes that are in the document; the payment webhook is hidden) | ok |
| Operations that document an error response | was 0 / 304; **now 303 / 304** (all but the liveness probe) | fixed, F-008; statuses documented: 400 ×258, 401 ×295, 403 ×295, 404 ×155, 422 ×1, 429 ×302, 500 ×302, 503 ×303 |
| 2xx operations with no response schema | was 19, **now 0** (fixed, F-009; they were audit-logs, password-reset, alerts summary, deletion-request, photo confirm ×2, notifications health/read-all, receipt pdf, payments-export, payment exceptions ×2, readiness, retention preview, reports ×2, dashboard, health live) | Mostly typed-by-code but undocumented in Swagger; clients cannot generate types for them. F-009. |
| `operationId` present | 304 / 304 | ok |
| Error envelope | `{ code, message, details?, requestId }` for every thrown error; unknown errors become a generic body; stack, SQL, paths never returned | `all-exceptions.filter.ts`; `security.api` "answers every failure in the one envelope" |
| `Cache-Control: no-store` and JSON content type forced on errors (so a CSV or cached handler header cannot leak into an error) | PASS | filter + unit test |
| Wrong decorator | `GET /admin/notification-events` was documented as a page of `TemplateView` but returns a plain array of `EventView`; fixed (F-010). |

## C. HTTP status codes

| Case | Behaviour | Verdict |
|---|---|---|
| Unauthenticated | 401 `UNAUTHENTICATED` | ok, tested on every protected route |
| Wrong user type / missing permission | 403 `FORBIDDEN`, audited | ok |
| Another user's resource | 404 (no existence leak) | ok (`qa.access`) |
| "Not now" state errors | 409 with domain code (`INVALID_TRANSITION`...) | ok |
| Semantic validation | 422 for domain rules, 400 for DTO validation | consistent, documented in tests |
| Rate limit | 429 `RATE_LIMITED` / `OTP_RESEND_COOLDOWN` | ok |
| Provider outage (SMS, storage, gateway) | 503 with stable code | ok |
| **Database or Redis unavailable** | was 500 INTERNAL_ERROR + Sentry; now 503 `SERVICE_UNAVAILABLE` after fixes F-004/F-011 | fixed and proven end to end, see 06 |
| Raw SQL defect | 500 + Sentry (kept on purpose) | ok |

## D. Error leakage

`security.api` and `qa.adversarial` assert no stack trace, SQL, file path, framework name or connection text in any error body. The filter replaces non-domain messages with generic text. Verified again in the dependency-failure run: 503 bodies carry only `code`, `message`, `requestId`.

## Findings from this document

| ID | Sev | Summary |
|---|---|---|
| F-008 | P3 | fixed: `addStandardErrorResponses` adds 400/401/403/404/429/500/503 with the shared `ApiError` schema to every operation. |
| F-009 | P3 | fixed: all 19 now have a schema (inline schema, model, nullable model or file response). |
| F-010 | P3 | fixed. |

None of these changes runtime behaviour; `docs/openapi.json` was regenerated. Enforced by the new test in `contract.openapi.int-spec`. Domain-specific error codes are described in the `ApiError.code` text, not listed per operation.
