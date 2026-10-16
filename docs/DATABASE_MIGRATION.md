# Backup, disaster recovery and moving to another database (Supabase -> AWS RDS)

What rebuilds what:
| You need | Use | Result |
|---|---|---|
| All tables, empty | `prisma migrate deploy` (all 21+ migrations in `prisma/migrations`) | schema only |
| Reference data | `npm run seed` + `npm run seed:launch` | roles, permissions, categories, pilot areas, starter templates |
| **Real data** (users, workers, bookings, payments, ratings, audit) | a **backup** (`scripts/db/backup.sh`) restored with `scripts/db/restore.sh` | everything exactly as it was |
Migrations and seeds can NOT recreate real customers, workers or bookings: that data exists only in a database backup. Take backups regularly.

## 0. Migration naming and immutability (DEC-13, enforced in CI)
- Prisma applies migrations in **name order** (the leading timestamp). Some existing directories carry timestamps later than their real date. They are **not renamed**: a database that already ran them would fail `migrate deploy` if their names changed.
- A **new** migration must be named with a timestamp **later than the newest existing directory** (not today's date if that sorts earlier), e.g. `ls prisma/migrations | tail -2`, then pick the next one.
- A migration that is already on `main` is **never edited, renamed or deleted**. Fix a mistake with a new migration.
- Migrations are additive and backward compatible (new nullable column, new table, new enum value, new index); reverse them with a later migration.
- CI runs `npm run check:migrations` (`MIGRATION_BASE_REF`, default `origin/main`): it fails when a new directory sorts before the newest one on the base branch, or when a base migration is touched. Locally: `git fetch origin main && npm run build && npm run check:migrations`.

## 1. Back up (do this on a schedule, and before every deploy with a migration)
```bash
SOURCE_DATABASE_URL='postgresql://...supabase direct URL, port 5432...' ./scripts/db/backup.sh
```
Also keep Supabase's automatic backups on. Copy the `.dump` file somewhere other than the same account (for example an S3 bucket). KYC documents are files in the storage bucket, not in the database: copy that bucket too (for example `aws s3 sync`), or enable bucket versioning.

## 2. Move Supabase -> AWS RDS (PostgreSQL 15+; 17 recommended)
1. Create the RDS instance and an empty database `sevanest`. Allow the machine that runs the commands in the security group.
2. Stop writes (maintenance window), then take a fresh backup (step 1).
3. Restore into the empty RDS database:
```bash
TARGET_DATABASE_URL='postgresql://user:pass@<rds-host>:5432/sevanest' ./scripts/db/restore.sh backup-....dump
```
4. Check it matches the code:
```bash
DATABASE_URL='postgresql://...rds...' npx prisma migrate status    # expect: Database schema is up to date
```
5. Point the API and worker at RDS (`DATABASE_URL` on Render or wherever they run), deploy, and check `/health/ready`, an admin login and a customer search.
6. Keep Supabase untouched for a few days as a fallback, then retire it.
Also move the object storage (KYC) and update `STORAGE_*` settings if the provider changes. Redis (queues, rate limits, OTP) is not authoritative and needs no migration.

## 3. Brand-new empty environment (no real data)
```bash
TARGET_DATABASE_URL='postgresql://...' ./scripts/db/new-empty-database.sh
```
Creates every table and the reference data, then follow the README's `bootstrap:admin` step to create the first Super Admin. Customers, workers and bookings start empty.

## 4. Disaster recovery (database lost)
Create a new empty database, run `restore.sh` with the latest backup, run `prisma migrate status`, repoint `DATABASE_URL`. Anything written after the backup is lost, so back up often and use Supabase/RDS point-in-time recovery where the plan allows.

## Rules
Never run `prisma migrate reset`, `db push --force-reset`, `DROP` or `TRUNCATE` on a database with real data. Use a direct (non-pooled) connection for `pg_dump`, `pg_restore` and `prisma migrate`.
