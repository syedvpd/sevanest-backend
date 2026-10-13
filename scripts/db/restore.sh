#!/usr/bin/env bash
# Restores a backup.sh file into an EMPTY database (a new RDS/Postgres). It refuses a database that already has tables.
#   TARGET_DATABASE_URL='postgresql://user:pass@host:5432/sevanest' ./scripts/db/restore.sh backup-20261013.dump
set -euo pipefail
: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL}"
FILE="${1:?usage: restore.sh <backup.dump>}"
psqlr() { if command -v psql >/dev/null 2>&1; then psql "$@"; else docker run --rm -i postgres:17-alpine psql "$@"; fi; }
restorer() { if command -v pg_restore >/dev/null 2>&1; then pg_restore "$@"; else docker run --rm -i postgres:17-alpine pg_restore "$@"; fi; }
TABLES=$(psqlr "$TARGET_DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema='public'")
if [ "$TABLES" != "0" ]; then echo "Refusing: target already has $TABLES tables in schema public (restore only into an empty database)"; exit 1; fi
psqlr "$TARGET_DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS btree_gist;'
# The only error expected is "schema public already exists" (every database has it); anything else fails the restore.
ERRORS=$(restorer --no-owner --no-acl --dbname="$TARGET_DATABASE_URL" < "$FILE" 2>&1 >/dev/null | grep -E "^pg_restore: error" | grep -v 'schema "public" already exists' || true)
if [ -n "$ERRORS" ]; then echo "$ERRORS"; echo "Restore FAILED (see errors above). Drop and recreate the empty target before retrying."; exit 1; fi
echo "Restored. Now run:  DATABASE_URL=\$TARGET_DATABASE_URL npx prisma migrate status"
