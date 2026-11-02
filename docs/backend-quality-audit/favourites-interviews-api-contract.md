# Favourites and Interviews: API contract (additive, backward compatible)

All paths under `/api/v1`, customer token.

## `GET /interviews`

Query adds `scope=upcoming|past` (other values: 400). Existing `status`, `type`, `page`, `limit` unchanged.

```json
{
  "data": [
    {
      "id": "…",
      "bookingId": "…",
      "type": "INTERVIEW",
      "status": "CONFIRMED",
      "statusLabel": "Confirmed",
      "preferredAt": "2026-11-04T10:00:00.000Z",
      "scheduledAt": "2026-11-04T10:00:00.000Z",
      "durationMinutes": 60,
      "worker": { "workerId": "…", "name": "Lakshmi D.", "initials": "LD", "photoUrl": null },
      "allowedActions": ["reschedule", "cancel", "complete"],
      "timeline": [
        { "title": "Requested", "state": "done", "at": "2026-11-02T06:00:00.000Z" },
        { "title": "Confirmed", "state": "done", "at": "2026-11-04T10:00:00.000Z" },
        { "title": "Outcome", "state": "upcoming", "at": null }
      ]
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 3 },
  "counts": { "upcoming": 2, "past": 1, "total": 3 }
}
```

- `durationMinutes`: the slot length (same as `slotMinutes` of `GET /search/workers/{id}/slots`, which is always present). Start is `scheduledAt`; end = start + `durationMinutes`. Present on every `InterviewView` (list, detail, actions, Home `upcomingInterview`, worker and admin views). It is a system constant, not stored per session.
- `worker` (list only): first name and last initial, initials, flat `photoUrl` (permanent link with public image storage, else short-lived). `null` only if the worker record is gone. No surname, contact or documents.
- `counts`: whole customer history, independent of page and filters. `upcoming` = open (REQUESTED, CONFIRMED, RESCHEDULE_PROPOSED), `past` = closed (DECLINED, CANCELLED, COMPLETED).
- `scope=upcoming`: soonest agreed time first, then waiting requests by asked time, id as tie-break. The first item is the next interview. For the confirmed-only next one, Home already returns `upcomingInterview`.
- `timeline[].at`: set for every `done` and `failed` step ("Confirmed" carries the interview time, "Declined" the last update time); `null` for `current` and `upcoming` steps. History of earlier reschedules is not kept.

## `GET /shortlist`

Query adds `category=<CODE>` (e.g. `HOUSE_MAID`; invalid format: 400).

```json
{
  "data": [{ "workerId": "…", "addedAt": "…", "available": true, "worker": { "…card…": "" } }],
  "meta": { "page": 1, "limit": 20, "total": 3 },
  "categoryCounts": [
    { "code": "COOK", "name": "Cook", "count": 2 },
    { "code": "HOUSE_MAID", "name": "House Maid", "count": 3 }
  ]
}
```

- `categoryCounts` covers the whole shortlist, independent of page and filter; sorted by name. A worker with two categories counts in both. Unavailable workers are not counted. With `category`, `meta.total` is the filtered size and unavailable entries are left out.

## Worker card (shortlist, search, profile)

Adds `canRequestInterview: boolean` and `cannotRequestReason: "VERIFICATION_PENDING" | null`. Informational only; `POST /interviews` enforces its own rules. A card exists only for a fully verified, active worker, so today every card has `true` / `null`; `VERIFICATION_PENDING` is reserved and never returned yet. Clients treat any other value as a generic "cannot request right now".

## Not in the contract (decisions)

`monthlyRate` (deferred until product defines a public rate), interview event history (deferred), per-session duration (60 is the working value, product to confirm), whether an open session whose time passed stays `upcoming` (product to confirm; it stays `upcoming` today).
