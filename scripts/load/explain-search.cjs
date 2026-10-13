// EXPLAIN ANALYZE the worker-search statements on the LOCAL load database (never a hosted one).
//   LOAD_DATABASE_URL=postgresql://.../sevanest_perf_ci node scripts/load/explain-search.cjs
const { Client } = require('pg');
const { SearchRepository } = require('../../dist/modules/search/search.repository');

const url = process.env.LOAD_DATABASE_URL;
if (!url || /supabase|render\.com|amazonaws/i.test(url))
  throw new Error('LOAD_DATABASE_URL (local) is required');

(async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  const cat = (await db.query(`SELECT id FROM service_categories WHERE code = 'HOUSE_MAID'`))
    .rows[0].id;
  const area = (
    await db.query(`SELECT id FROM service_areas WHERE city = 'Hyderabad' ORDER BY name LIMIT 1`)
  ).rows[0].id;
  const captured = [];
  const fakePrisma = {
    $queryRaw: (sql) => {
      captured.push(sql);
      return Promise.resolve([]);
    },
  };
  const repo = new SearchRepository(fakePrisma, { travelBufferMinutes: 0 });
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const scenario = process.env.SCENARIO ?? 'timeWindow';
  const criteria = {
    categoryId: cat,
    areaId: area,
    engagement: 'PART_TIME',
    window: { fromMinute: 540, toMinute: 600 },
    startDate: day,
  };
  if (scenario === 'plain') delete criteria.window;
  // findEligible would hydrate; call it with the fake so only the page and count statements are captured.
  try {
    await repo.findEligible(criteria, 'EXPERIENCE_DESC', 0, 20);
  } catch {
    /* hydrate on empty rows is a no-op */
  }
  for (const sql of captured.slice(0, 2)) {
    const res = await db.query({
      text: 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ' + sql.text,
      values: sql.values,
    });
    console.log('-----', sql.text.includes('count(*)') ? 'COUNT' : 'PAGE');
    console.log(res.rows.map((r) => r['QUERY PLAN']).join('\n'));
  }
  await db.end();
})();
