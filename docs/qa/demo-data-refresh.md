# Demo data refresh (2026-10-27)

Replaces the repeated demo people on the shared Supabase database with varied, realistic and **fictional** ones, and gives every service category three live workers. Script: `scripts/seed-demo-refresh.mjs`. No real person, phone, Aadhaar or other document is used; e-mails use `example.com`.

## What changed on the shared database

| Area | Change |
|---|---|
| Demo workers `+919000000101..112` (12) | Renamed; experience, languages and pay varied. `105` and `111` became Drivers, `110` a Babysitter, `112` an Elderly Care Helper (their old House Maid skill row was replaced; they had no open House Maid bookings). Ids, mobiles, bookings, ratings and shortlists kept. |
| New demo workers `+919000000113..120` (8) | 1 Driver, 2 Babysitters, 2 Elderly Care Helpers, 3 Cleaning Helpers. Each has identity approved, an application reference, sign-off and activation (D-90), so they are live in search. |
| Demo customers `+919000000201..206` (6) | Renamed, e-mail changed, default address street and pincode made consistent with the area. 14 bookings and 8 payments untouched. |
| Areas | "Hitech City" merged into "HITEC City" (6 worker preferences, 2 bookings, 2 addresses moved) and disabled. Nothing deleted except the duplicate preference rows that were moved. |
| Engagements (2026-10-27) | Category engagement types applied per the customer-app team's table; Cook-holders prefer PART_TIME, Drivers DAILY (see `docs/qa/service-categories-audit.md`). |
| Result | Live workers per category: Babysitter 3, Cleaning Helper 3, Cook 3, Driver 3, Elderly Care Helper 3, House Maid 8 (eight maids stay because the demo bookings belong to them). |

## Not touched
Every account outside the allow-list: the team's own customers and workers (for example the developer e-mails), the empty "Worker" drafts, "Verification Test Worker", all admin users. The script reads and writes only the mobiles above and stops with an error if a row in the allow-list carries a name it does not recognise.

## How it was done and how to repeat or undo
1. `pg_dump -n public -Fc` backups, kept outside the repo (`C:\Users\ABC\sevanest-backups\`): `supabase-public-20261027-103120.dump` and `supabase-public-pre-refresh-20261027-103824.dump` (taken just before the change).
2. Rehearsal on a local restore of the dump, checked through the real API (login with the test OTP, search per category and area, Home, bookings): 20 distinct workers, three visible per category, bookings intact.
3. `CONFIRM_HOSTED=yes DATABASE_URL=... node scripts/seed-demo-refresh.mjs` (dry run, prints the plan and rolls back), then `--apply` (one transaction). Safe to run again: the second run changed nothing.
4. Undo: restore the pre-refresh dump into a scratch database and copy the rows back, or `pg_restore` into an empty database if the whole database is lost. Structure comes from the 41 migrations in `prisma/migrations/`, reference data from `src/seed.ts`.

## For app developers
Demo logins are unchanged (same mobiles). Customer names in the apps are now Sneha Kulkarni, Rajesh Agarwal, Meera Subramanian, Imran Qureshi, Divya Chowdary and Harish Balakrishnan; workers show as first name and last initial (for example "Sarojini K.").
