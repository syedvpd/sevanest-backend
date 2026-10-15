// Compares two performance CSVs (as written by report.mjs) operation by operation.
// Usage: node scripts/perf/compare.mjs <before.csv> <after.csv> [out.csv]
import { readFileSync, writeFileSync } from 'node:fs';

const [beforeFile, afterFile, outFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error('Usage: node scripts/perf/compare.mjs <before.csv> <after.csv> [out.csv]');
  process.exit(2);
}
const parse = (file) => {
  const map = new Map();
  const [head, ...lines] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  for (const line of lines) {
    const cells = line
      .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
      .map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const row = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
    map.set(row.operation, row);
  }
  return map;
};
const before = parse(beforeFile);
const after = parse(afterFile);
const num = (v) => Number(v);
const rows = [];
for (const [op, a] of after) {
  const b = before.get(op);
  if (!b) continue;
  rows.push({
    operation: op,
    module: a.module,
    before_p50: num(b.p50_ms),
    after_p50: num(a.p50_ms),
    before_p95: num(b.p95_ms),
    after_p95: num(a.p95_ms),
    before_p99: num(b.p99_ms),
    after_p99: num(a.p99_ms),
    delta_p50_ms: Math.round((num(a.p50_ms) - num(b.p50_ms)) * 10) / 10,
  });
}
rows.sort((x, y) => x.delta_p50_ms - y.delta_p50_ms);
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
console.log(
  `${rows.length} operations compared; summed p50 ${Math.round(sum('before_p50'))} -> ${Math.round(sum('after_p50'))} ms; summed p95 ${Math.round(sum('before_p95'))} -> ${Math.round(sum('after_p95'))} ms`,
);
console.log('largest improvements:');
rows
  .slice(0, 8)
  .forEach((r) => console.log(`  ${r.operation}  p50 ${r.before_p50} -> ${r.after_p50}`));
console.log('largest regressions:');
rows
  .slice(-6)
  .reverse()
  .forEach((r) => console.log(`  ${r.operation}  p50 ${r.before_p50} -> ${r.after_p50}`));
if (outFile) {
  const head = Object.keys(rows[0]).join(',');
  writeFileSync(
    outFile,
    [
      head,
      ...rows.map((r) =>
        Object.values(r)
          .map((v) => (typeof v === 'string' ? `"${v}"` : v))
          .join(','),
      ),
    ].join('\n') + '\n',
  );
}
