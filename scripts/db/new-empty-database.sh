#!/usr/bin/env bash
# Builds a brand-new, EMPTY but fully working database: every table (all migrations) + reference data (roles, permissions, categories,
# pilot areas, starter templates). No customers/workers/bookings: those exist only in a backup (see restore.sh).
#   TARGET_DATABASE_URL='postgresql://user:pass@host:5432/sevanest' ./scripts/db/new-empty-database.sh
set -euo pipefail
: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL}"
export DATABASE_URL="$TARGET_DATABASE_URL"
npx prisma migrate deploy        # creates every table; never drops or resets
npm run build
npm run seed                      # roles, permissions, service categories (idempotent)
npm run seed:launch               # pilot areas + starter notification templates (idempotent)
echo "Create the first Super Admin in the target environment with: npm run bootstrap:admin  (see README)"
