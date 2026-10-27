import { CategorySeedService, RECOMMENDED_ENGAGEMENTS } from './category-seed.service';
import { ENGAGEMENTS } from '../../common/validation/engagements';

/** In-memory stand-ins for the repository and audit, so the seed rules can be checked without a database. */
function setup(initial: Record<string, string[]> = {}, missing: string[] = []) {
  const ids = new Map<string, string>();
  const engagements = new Map<string, string[]>();
  for (const code of Object.keys(RECOMMENDED_ENGAGEMENTS)) {
    if (missing.includes(code)) continue;
    ids.set(code, `id-${code}`);
    if (initial[code]) engagements.set(`id-${code}`, initial[code]);
  }
  const audited: unknown[] = [];
  const repository = {
    findByCode: jest.fn((code: string) =>
      Promise.resolve(ids.has(code) ? { id: ids.get(code)!, code } : null),
    ),
    engagementsOf: jest.fn((categoryIds: string[]) => {
      const out = new Map<string, string[]>();
      for (const id of categoryIds) if (engagements.has(id)) out.set(id, engagements.get(id)!);
      return Promise.resolve(out);
    }),
    transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})),
    lockById: jest.fn((_id: string, _tx?: unknown) => Promise.resolve(null)),
    replaceEngagements: jest.fn((id: string, list: string[]) => {
      engagements.set(id, list);
      return Promise.resolve();
    }),
  };
  const audit = { record: jest.fn((entry: unknown) => (audited.push(entry), Promise.resolve())) };
  const service = new CategorySeedService(repository as never, audit as never);
  return { service, repository, engagements, audited };
}

describe('RECOMMENDED_ENGAGEMENTS (PRD section 4)', () => {
  it('covers the six categories with values the platform knows', () => {
    expect(Object.keys(RECOMMENDED_ENGAGEMENTS).sort()).toEqual([
      'BABYSITTER',
      'CLEANING_HELPER',
      'COOK',
      'DRIVER',
      'ELDERLY_CARE_HELPER',
      'HOUSE_MAID',
    ]);
    for (const list of Object.values(RECOMMENDED_ENGAGEMENTS)) {
      expect(new Set(list).size).toBe(list.length);
      for (const e of list) expect(ENGAGEMENTS).toContain(e);
    }
    expect(RECOMMENDED_ENGAGEMENTS.HOUSE_MAID).toEqual(['PART_TIME', 'FULL_TIME', 'LIVE_IN']);
    expect(RECOMMENDED_ENGAGEMENTS.CLEANING_HELPER).toEqual(['ONE_TIME', 'HOURLY']);
    expect(RECOMMENDED_ENGAGEMENTS.ELDERLY_CARE_HELPER).toContain('SHIFT');
  });
});

describe('CategorySeedService.ensureRecommendedEngagements', () => {
  it('fills only unconfigured categories, sorted, audited without an actor', async () => {
    const { service, engagements, audited } = setup();
    const report = await service.ensureRecommendedEngagements();
    expect(report.applied.map((a) => a.code).sort()).toEqual(
      Object.keys(RECOMMENDED_ENGAGEMENTS).sort(),
    );
    expect(engagements.get('id-DRIVER')).toEqual(['DAILY', 'FULL_TIME', 'HOURLY']);
    expect(audited).toHaveLength(6);
    expect(audited[0]).toMatchObject({
      action: 'service_category.engagements_seeded',
      actorId: null,
    });
  });

  it('never overwrites an administrator choice, including a restriction to one value', async () => {
    const { service, engagements } = setup({ DRIVER: ['HOURLY'], COOK: ['MONTHLY_X'] });
    const report = await service.ensureRecommendedEngagements();
    expect(report.skippedAlreadyConfigured.sort()).toEqual(['COOK', 'DRIVER']);
    expect(engagements.get('id-DRIVER')).toEqual(['HOURLY']);
    expect(engagements.get('id-COOK')).toEqual(['MONTHLY_X']);
    expect(report.applied.map((a) => a.code)).not.toContain('DRIVER');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { service, repository, audited } = setup();
    await service.ensureRecommendedEngagements();
    const writes = repository.replaceEngagements.mock.calls.length;
    const second = await service.ensureRecommendedEngagements();
    expect(second.applied).toEqual([]);
    expect(second.skippedAlreadyConfigured).toHaveLength(6);
    expect(repository.replaceEngagements.mock.calls.length).toBe(writes);
    expect(audited).toHaveLength(6);
  });

  it('a dry run reports the plan and writes nothing', async () => {
    const { service, repository, engagements, audited } = setup();
    const report = await service.ensureRecommendedEngagements(true);
    expect(report.applied).toHaveLength(6);
    expect(repository.replaceEngagements).not.toHaveBeenCalled();
    expect(engagements.size).toBe(0);
    expect(audited).toHaveLength(0);
  });

  it('skips a category that does not exist (renamed code or never seeded)', async () => {
    const { service } = setup({}, ['BABYSITTER']);
    const report = await service.ensureRecommendedEngagements();
    expect(report.skippedMissing).toEqual(['BABYSITTER']);
    expect(report.applied).toHaveLength(5);
  });

  it('lets a concurrent admin edit win (re-check under the row lock)', async () => {
    const { service, repository, engagements } = setup();
    repository.lockById.mockImplementation((id: string) => {
      if (id === 'id-DRIVER') engagements.set('id-DRIVER', ['SHIFT']); // an admin saved between the check and the lock
      return Promise.resolve(null);
    });
    const report = await service.ensureRecommendedEngagements();
    expect(engagements.get('id-DRIVER')).toEqual(['SHIFT']);
    expect(report.skippedAlreadyConfigured).toContain('DRIVER');
    expect(report.applied.map((a) => a.code)).not.toContain('DRIVER');
  });
});
