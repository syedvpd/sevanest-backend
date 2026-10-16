/**
 * Rules for Prisma migrations that are already (or may already be) applied somewhere (DEC-13, docs/DATABASE_MIGRATION.md):
 *  1. a NEW migration directory must sort AFTER the newest one that exists on the base branch, otherwise a database that already ran the
 *     newer ones sees it out of order;
 *  2. a migration that exists on the base branch is never edited, renamed or deleted.
 * Pure functions so they can be tested; src/check-migration-order.ts feeds them from git.
 */

export interface MigrationOrderProblem {
  kind: 'OUT_OF_ORDER' | 'CHANGED_EXISTING';
  detail: string;
}

/** `base` = directory names on the base branch, `head` = directory names now. */
export function findOutOfOrder(
  base: readonly string[],
  head: readonly string[],
): MigrationOrderProblem[] {
  const existing = new Set(base);
  const newest = [...base].sort().at(-1);
  if (!newest) return [];
  return head
    .filter((name) => !existing.has(name) && name < newest)
    .map((name) => ({
      kind: 'OUT_OF_ORDER' as const,
      detail: `${name} sorts before ${newest}, the newest migration on the base branch. Rename the NEW directory with a later timestamp (never rename an applied one).`,
    }));
}

/** `diff` = lines of \`git diff --name-status <base> -- prisma/migrations\` (status, tab, path[, tab, path]). */
export function findChangedExisting(
  base: readonly string[],
  diff: readonly string[],
): MigrationOrderProblem[] {
  const existing = new Set(base);
  const problems: MigrationOrderProblem[] = [];
  for (const line of diff) {
    const [status, ...paths] = line.split('\t');
    if (!status || status === 'A') continue;
    const touched = paths
      .map((p) => p.replace(/^prisma\/migrations\//, '').split('/')[0])
      .filter((dir): dir is string => !!dir && existing.has(dir));
    if (touched.length > 0) {
      problems.push({
        kind: 'CHANGED_EXISTING',
        detail: `${status} ${paths.join(' -> ')}: an existing migration was modified, renamed or deleted. Add a new migration instead.`,
      });
    }
  }
  return problems;
}
