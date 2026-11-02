# Favourites and Interviews: performance report (2026-11-02)

**No benchmark was run. No p50 / p95 / p99, query-count or latency claim is made, and the 300 ms and 100 ms targets are unverified.**

Design facts (from the code, not measured):

- `GET /interviews`: one page query plus two counts, then one bookings look-up and one worker-display batch for the page (no per-row query). Counts are two `COUNT` statements over the customer's sessions.
- `GET /shortlist`: one query for the customer's entries (at most 100), one SQL statement for their categories, then cards for the requested page only. Heavier than before (the previous version read one page); bounded by the 100-entry cap.
- `GET /search/workers/count`: same eligibility query as the search with `LIMIT 1`.
- `GET /search/workers/{id}/ratings`: adds one grouped query on `ratings` by worker.
- No Redis caching added; no index added. Not checked with `EXPLAIN`.

To close this: run the endpoints against a seeded database (about 100 shortlist entries, a few hundred interviews) with a load tool and record percentiles and statement counts.
