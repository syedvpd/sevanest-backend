import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { findChangedExisting, findOutOfOrder } from './common/migrations/migration-order';

/**
 * CI guard (DEC-13): `npm run check:migrations`. Compares prisma/migrations with the base branch (MIGRATION_BASE_REF, default origin/main) and
 * fails when a new migration sorts before the newest existing one, or an existing migration was edited, renamed or deleted.
 * Needs the base ref in the checkout (CI: fetch-depth 0). Without a resolvable base it says so and passes, so a local checkout without
 * a remote is not blocked; CI always has the ref.
 */
function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main(): number {
  const ref = process.env.MIGRATION_BASE_REF ?? 'origin/main';
  let base: string[];
  try {
    base = git(['ls-tree', '-d', '--name-only', ref, 'prisma/migrations/'])
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^prisma\/migrations\/?/, '').replace(/\/$/, ''))
      .filter(Boolean);
  } catch {
    console.warn(`check-migration-order: base ref "${ref}" is not available here; skipped.`);
    return 0;
  }
  const head = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const diff = git(['diff', '--name-status', '-M', ref, '--', 'prisma/migrations'])
    .split('\n')
    .filter(Boolean);
  const problems = [...findOutOfOrder(base, head), ...findChangedExisting(base, diff)];
  if (problems.length === 0) {
    console.log(
      `check-migration-order: ok (${head.length - base.length} new migration(s) after ${ref}).`,
    );
    return 0;
  }
  for (const problem of problems)
    console.error(`check-migration-order: ${problem.kind}: ${problem.detail}`);
  return 1;
}

process.exit(main());
