#!/usr/bin/env bash
# Full backup (schema + ALL data) of the application's `public` schema to a compressed file.
#   SOURCE_DATABASE_URL='postgresql://user:pass@host:5432/postgres' ./scripts/db/backup.sh [out-file]
# Supabase: use the DIRECT connection (port 5432, not the transaction pooler). Needs pg_dump (v17) or Docker.
set -euo pipefail
: "${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL}"
OUT="${1:-backup-$(date +%Y%m%d-%H%M%S).dump}"
run() { if command -v pg_dump >/dev/null 2>&1; then pg_dump "$@"; else docker run --rm -i postgres:17-alpine pg_dump "$@"; fi; }
# custom format, only our schema, no owners/ACLs (so it restores into any provider, e.g. AWS RDS)
run --format=custom --no-owner --no-acl --schema=public "$SOURCE_DATABASE_URL" > "$OUT"
echo "Backup written to $OUT ($(wc -c < "$OUT") bytes)"
