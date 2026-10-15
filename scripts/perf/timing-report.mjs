// Summarises the per-request timing lines of a perf run (REQUEST_TIMING_LOG=true, test/perf/out/timing.jsonl):
// for every route template the number of calls, median/p95 wall time, and the median/max number of database statements.
// Usage: node scripts/perf/timing-report.mjs [timing.jsonl=test/perf/out/timing.jsonl] [topN=40]
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'test/perf/out/timing.jsonl';
const top = Number(process.argv[3] ?? 40);
const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

const groups = new Map();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.msg !== 'request') continue;
  const key = `${r.method} ${r.route}`;
  const g = groups.get(key) ?? { ms: [], q: [], db: [], statuses: new Set() };
  g.ms.push(r.ms);
  g.q.push(r.queries);
  g.db.push(r.dbMs);
  g.statuses.add(r.status);
  groups.set(key, g);
}
const rows = [...groups].map(([key, g]) => {
  const ms = [...g.ms].sort((a, b) => a - b),
    q = [...g.q].sort((a, b) => a - b),
    db = [...g.db].sort((a, b) => a - b);
  return {
    key,
    n: ms.length,
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    q50: pct(q, 50),
    qMax: q.at(-1),
    db50: pct(db, 50),
    st: [...g.statuses].join('/'),
  };
});
console.log(
  'method route | n | p50 ms | p95 ms | queries p50 | queries max | db ms p50 | statuses',
);
for (const r of rows.sort((a, b) => b.qMax - a.qMax || b.p95 - a.p95).slice(0, top)) {
  console.log(
    `${r.key} | ${r.n} | ${r.p50} | ${r.p95} | ${r.q50} | ${r.qMax} | ${r.db50} | ${r.st}`,
  );
}
