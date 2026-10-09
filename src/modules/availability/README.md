# Availability

A worker's engagement preference, preferred service areas and daily available time windows, plus the service-area master.

## Requirements covered

FR-WP-003 (preferred work locations), FR-WP-005 (available timings), FR-WP-006 (full-time / part-time / live-in preference),
FRD FM-04 ("Available timings: valid ranges", "Preferred locations: enabled service areas", preference: Select),
FM-16 (areas: unique within the city, enabled/disabled), FR-ADM-005 (admins manage availability), FR-SD-005 / FM-03 (data that
search filters by category, location and availability will read).

## Domain model

- `service_areas`: `name`, `city`, `is_enabled`; unique per (city, name) ignoring case. **No areas are seeded**: the documents name
  pilot localities only as launch planning, so an admin creates the areas.
- `worker_work_preferences`: one row per worker, `engagement_preference` FULL_TIME | PART_TIME | LIVE_IN (a single "Select").
- `worker_preferred_areas`: (worker, area).
- `worker_time_windows`: (worker, `start_minute`, `end_minute`): minutes after local midnight, `[start, end)`, one timezone (India),
  applied every day. The documents mention no weekdays, so none are modelled.

## APIs (`/api/v1`)

| Method         | Path                                     | Requires           | Purpose                                                                                     |
| -------------- | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| GET            | `/service-areas?city=`                   | any signed-in user | Enabled areas, paginated                                                                    |
| GET            | `/service-areas/{areaId}`                | any signed-in user | One enabled area                                                                            |
| GET/POST/PATCH | `/admin/service-areas[/{areaId}]`        | `area.manage`      | Manage the master                                                                           |
| GET            | `/workers/me/availability`               | WORKER             | `{ engagementPreference, areas[], timeWindows[{start,end}] }`                               |
| PATCH          | `/workers/me/availability`               | WORKER             | `{ engagementPreference?, areaIds?, timeWindows? }`; each part sent replaces the stored one |
| GET            | `/admin/workers/{workerId}/availability` | `worker.view`      | A worker's availability                                                                     |
| PATCH          | `/admin/workers/{workerId}/availability` | `worker.manage`    | Assisted edit                                                                               |

## Rules

- Times are `HH:mm` (24 h); `24:00` is allowed only as an end. A window must start before it ends and stay inside one day (no overnight
  windows); windows of one worker must not overlap or repeat; windows that only touch (09:00-12:00 and 12:00-14:00) are allowed;
  1-24 windows; 1-50 areas (technical bounds).
- New areas must be enabled (422 `AREA_NOT_AVAILABLE`); areas already held may stay if later disabled; unknown ids are 400.
- A request is atomic: if any part fails, none is saved. Validation of windows happens before the database is touched.
- These items are mandatory for submitting a worker profile (contributed to Workers through `WorkerSubmissionRegistry`).

## Database guarantees and concurrency

`worker_time_windows` has CHECK `0 <= start < end <= 1440` and a GiST exclusion constraint (`btree_gist`) forbidding overlapping
windows for one worker, so the rule holds even if the application is bypassed. Updates take a transaction-scoped advisory lock keyed by
the worker id (it does not lock the Workers table), so parallel updates serialise and the last writer wins whole.

## Indexes and the future Search/Matching query

Indexes: unique (city, name) on areas; `worker_preferred_areas(area_id)` (reverse lookup "workers in area X"; the primary key serves
"areas of worker W"); the exclusion constraint's GiST index on `(worker_id, range)` serves per-worker window lookups. A query such as
"workers in area X available 09:00-12:00" is `worker_preferred_areas.area_id = X` joined to `worker_time_windows` with
`start_minute <= 540 AND end_minute >= 720`; this is exercised in the integration tests. No time-range index was added: its shape depends
on the real Search query and should be chosen with `EXPLAIN` on production-like data. Windows that touch can jointly cover a longer
period; Search must merge adjacent windows if it wants union coverage.

## Audit

`availability.update` (changed parts, preference from/to, area ids added/removed, window counts before/after; admin edits record the
admin), `service_area.create`, `service_area.update` (before/after).

## Open decisions

Weekday granularity, effective dates, recurring vs one-time availability, overnight windows, a temporary "not available" switch;
single vs multiple engagement preferences and the engagement-type vocabulary; the area catalogue and ownership of config masters (Q-14);
timezone beyond India.
