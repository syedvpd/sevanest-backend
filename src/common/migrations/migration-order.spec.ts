import { findChangedExisting, findOutOfOrder } from './migration-order';

const base = ['20261031090000_a', '20261101090000_b'];

describe('findOutOfOrder', () => {
  it('accepts new migrations that sort after the newest base migration', () => {
    expect(findOutOfOrder(base, [...base, '20261102090000_c', '20261103090000_d'])).toEqual([]);
  });

  it('flags a new migration dated before the newest base migration', () => {
    const problems = findOutOfOrder(base, [...base, '20261016120000_hotfix']);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('OUT_OF_ORDER');
    expect(problems[0].detail).toContain('20261016120000_hotfix');
  });

  it('compares whole names, so the same timestamp is ordered by the rest of the name', () => {
    expect(findOutOfOrder(base, [...base, '20261101090000_c'])).toEqual([]);
    expect(findOutOfOrder(base, [...base, '20261101090000_a_second'])).toHaveLength(1);
  });

  it('has nothing to check when the base has no migrations', () => {
    expect(findOutOfOrder([], ['19990101000000_x'])).toEqual([]);
  });
});

describe('findChangedExisting', () => {
  it('allows added files and files of new migrations', () => {
    expect(
      findChangedExisting(base, [
        'A\tprisma/migrations/20261102090000_c/migration.sql',
        'M\tprisma/migrations/20261102090000_c/migration.sql',
        'M\tprisma/schema.prisma',
      ]),
    ).toEqual([]);
  });

  it('flags edits, deletions and renames of an existing migration', () => {
    const problems = findChangedExisting(base, [
      'M\tprisma/migrations/20261101090000_b/migration.sql',
      'D\tprisma/migrations/20261031090000_a/migration.sql',
      'R100\tprisma/migrations/20261031090000_a/migration.sql\tprisma/migrations/20261201090000_a/migration.sql',
    ]);
    expect(problems.map((p) => p.kind)).toEqual([
      'CHANGED_EXISTING',
      'CHANGED_EXISTING',
      'CHANGED_EXISTING',
    ]);
  });
});
