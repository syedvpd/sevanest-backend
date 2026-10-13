# scripts

| Path                                                        | Use                                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/backup.sh`, `db/restore.sh`, `db/new-empty-database.sh` | backup, restore and rebuild a database (see `docs/DATABASE_MIGRATION.md`)                                                                                              |
| `seed-demo.ts`, `seed-demo-env.ts`                          | richer demo data through the real HTTP API (bookings in every state); **local database only**, needs object storage; the Docker stack uses `npm run seed:demo` instead |
| `load/`                                                     | local load-test tools: `seed.sql` (100,000 synthetic users), `run.mjs` (HTTP load driver), `explain-search.cjs` (query plans). Never point at a hosted database        |
