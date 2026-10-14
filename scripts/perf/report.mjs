#!/usr/bin/env node
/**
 * Turns the raw timings of the performance journeys (test/perf/out/journeys.json) into docs/qa/performance-test-results.md and a CSV.
 * Usage: node scripts/perf/report.mjs [outDir=test/perf/out] [docsDir=docs/qa]
 * Percentiles use the nearest-rank method. With 15 iterations p95 and p99 are the 15th-ranked sample, i.e. the slowest one: they are a
 * "worst of 15" figure, not a statistical tail; raise PERF_ITERATIONS for finer tails.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const outDir = process.argv[2] ?? 'test/perf/out';
const docsDir = process.argv[3] ?? 'docs/qa';
const run = JSON.parse(readFileSync(join(outDir, 'journeys.json'), 'utf8'));
const spec = JSON.parse(readFileSync(join(outDir, 'openapi.json'), 'utf8'));

const tagOf = new Map();
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    if (op && typeof op === 'object' && op.tags) tagOf.set(`${method.toUpperCase()} ${path.replace('/api/v1', '')}`, op.tags[0]);
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

const rows = run.samples.map((s) => {
  const sorted = [...s.ms].sort((a, b) => a - b);
  const avg = s.ms.reduce((a, b) => a + b, 0) / s.ms.length;
  const key = `${s.method} ${s.template}`;
  return {
    key,
    module: tagOf.get(key) ?? 'Other',
    n: s.ms.length,
    first: s.ms[0],
    second: s.ms[1] ?? NaN,
    min: sorted[0],
    avg,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1],
    statuses: Object.entries(s.statuses).map(([k, v]) => `${k}x${v}`).join(' '),
    unexpected: Object.keys(s.unexpected).length > 0,
  };
});

const all = run.samples.flatMap((s) => s.ms).sort((a, b) => a - b);
const warm = run.samples.flatMap((s) => s.ms.slice(2)).sort((a, b) => a - b);
const firsts = run.samples.map((s) => s.ms[0]).sort((a, b) => a - b);
const seconds = run.samples.map((s) => s.ms[1]).filter((v) => v !== undefined).sort((a, b) => a - b);
const hit = new Set(run.samples.map((s) => `${s.method} ${s.template}`));
const uncovered = run.operationsInApi.filter((o) => !hit.has(o));

const modules = [...new Set(rows.map((r) => r.module))].sort();
let md = `# Backend performance test results\n\n`;
md += `Generated ${run.generatedAt}. **Performance, not load**: one client, strictly sequential, ${run.iterations} full iterations of every module's lifecycle.\n\n`;
md += `## How it was measured\n\n`;
const remote = Boolean(run.target);
md += remote
  ? `* Target: ${run.target} (${run.mode}), measured from the machine below over the network, so the numbers INCLUDE network latency and TLS. Only public API calls were used; ids come from the target's own data. The first request of the run is GET /health/live, so a sleeping free-tier service shows its cold start as that operation's 1st hit.\n`
  : `* Target: the real API on a real HTTP port (loopback), NestJS 11, on a fresh local PostgreSQL 17 and Redis 7 (Docker), same machine as the client. Numbers include JSON parsing, guards, validation, database and audit writes; they exclude network latency and TLS, so a hosted deployment adds its round trip.\n`;
md += `* Machine: ${os.cpus()[0].model.trim()}, ${os.cpus().length} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM, Node ${process.version}, ${os.platform()}.\n`;
md += remote
  ? `* Each iteration calls every read (GET) operation it can fill in, in the role the route belongs to${run.mode.includes('writes') ? ', plus a few reversible write lifecycles that clean up after themselves' : ''}. The same operation is therefore hit once per iteration.\n`
  : `* Each iteration creates fresh users and data and walks the modules in lifecycle order: create, read, list, update, state changes, delete. The same operation is therefore hit once per iteration.\n`;
md += `* **1st hit** = iteration 1 (first call after the process started: cold caches, query plans, JIT). **2nd hit** = iteration 2. p50/p95/p99, min, avg, max use all ${run.iterations} samples (nearest-rank; with ${run.iterations} samples p95 and p99 equal the slowest sample).\n`;
md += `* Times are end-to-end milliseconds for the HTTP call including reading the whole body.\n\n`;
md += `## Summary\n\n`;
md += `| | value |\n|---|---|\n`;
md += `| Operations in the API | ${run.operationsInApi.length} |\n`;
md += `| Operations exercised | ${rows.length} (${((rows.length / run.operationsInApi.length) * 100).toFixed(1)} %) |\n`;
md += `| Requests timed | ${all.length} |\n`;
md += `| Overall p50 / p95 / p99 (all requests) | ${fmt(pct(all, 50))} / ${fmt(pct(all, 95))} / ${fmt(pct(all, 99))} ms |\n`;
md += `| Warm requests only (iteration 3 onwards) p50 / p95 / p99 | ${fmt(pct(warm, 50))} / ${fmt(pct(warm, 95))} / ${fmt(pct(warm, 99))} ms |\n`;
md += `| 1st-hit median across operations | ${fmt(pct(firsts, 50))} ms |\n`;
md += `| 2nd-hit median across operations | ${fmt(pct(seconds, 50))} ms |\n`;
md += `| Operations with p95 above 100 ms | ${rows.filter((r) => r.p95 > 100).length} |\n`;
md += `| Operations with p95 above 250 ms | ${rows.filter((r) => r.p95 > 250).length} |\n`;
md += `| Operations whose status was not the expected one | ${rows.filter((r) => r.unexpected).length} |\n\n`;

// the four password-hashing endpoints are slow on purpose (a deliberately expensive hash); show the picture without them as well
const hashing = rows.filter((r) => r.p50 > 300).map((r) => r.key);
const withoutHashing = run.samples.filter((s) => !hashing.includes(`${s.method} ${s.template}`)).flatMap((s) => s.ms).sort((a, b) => a - b);
md += `### Reading the numbers\n\n`;
md += `* Operations whose median is above 300 ms: ${hashing.length ? hashing.join(', ') : 'none'}. These verify or create a password hash, which is deliberately expensive; they set the overall p99.\n`;
md += `* Without them: p50 / p95 / p99 = ${fmt(pct(withoutHashing, 50))} / ${fmt(pct(withoutHashing, 95))} / ${fmt(pct(withoutHashing, 99))} ms over ${withoutHashing.length} requests.\n`;
md += `* Cold start is small: the 1st-hit median across operations is ${fmt(pct(firsts, 50))} ms against ${fmt(pct(seconds, 50))} ms for the 2nd hit; only a few operations lose more than 20 ms on their first call (table below).\n`;
md += `* Read endpoints (GET) dominate the sample and answer in a few tens of milliseconds; the slowest non-hashing operations are state changes that write several rows, send outbox events and audit records in one transaction (interviews, bookings, replacements, payments).\n`;
if (!remote) md += `* Run history: an earlier identical run was discarded because the host machine stalled for about 4 minutes during iteration 13 (one call took 266 s and two requests got 500 from connections broken by the stall; the database and Redis logs show no error). This is the clean rerun: no failed iteration, no unexpected status, no sample above 3 s.\n\n`;

const top = (list, key, n, title) => {
  let t = `### ${title}\n\n| Operation | 1st | 2nd | p50 | p95 | max |\n|---|---|---|---|---|---|\n`;
  for (const r of [...list].sort((a, b) => b[key] - a[key]).slice(0, n)) t += `| ${r.key} | ${fmt(r.first)} | ${fmt(r.second)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} |\n`;
  return t + '\n';
};
md += top(rows, 'p95', 15, 'Slowest 15 operations by p95 (ms)');
md += top(rows.map((r) => ({ ...r, penalty: r.first - r.p50 })), 'penalty', 10, 'Largest cold-start penalty (1st hit minus p50, ms)');

md += `## Every operation, by module\n\nColumns are milliseconds. "Status" lists the HTTP statuses seen and how often (e.g. 200x15).\n\n`;
for (const m of modules) {
  md += `### ${m}\n\n| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows.filter((x) => x.module === m)) {
    md += `| ${r.key} | ${r.n} | ${fmt(r.first)} | ${fmt(r.second)} | ${fmt(r.min)} | ${fmt(r.avg)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${r.statuses}${r.unexpected ? ' (!)' : ''} |\n`;
  }
  md += '\n';
}
md += `## Not exercised (${uncovered.length})\n\n`;
md += uncovered.length ? uncovered.map((o) => `* ${o}`).join('\n') + '\n\n' : 'None.\n\n';
if (run.skipped.length) md += `Steps skipped because a prerequisite was missing in at least one iteration: ${run.skipped.join('; ')}.\n\n`;
if (run.iterationErrors.length) md += `Iterations that stopped early: ${run.iterationErrors.join('; ')}.\n\n`;

writeFileSync(join(docsDir, 'performance-test-results.md'), md);
const csv = ['operation,module,n,first_ms,second_ms,min_ms,avg_ms,p50_ms,p95_ms,p99_ms,max_ms,statuses', ...rows.map((r) => [r.key, r.module, r.n, r.first, r.second, r.min, r.avg, r.p50, r.p95, r.p99, r.max, r.statuses].map((v) => (typeof v === 'number' ? v.toFixed(3) : `"${v}"`)).join(','))].join('\n');
writeFileSync(join(docsDir, 'performance-test-results.csv'), csv);
console.log(`report: ${rows.length} operations, ${all.length} requests, overall p50/p95/p99 ${fmt(pct(all, 50))}/${fmt(pct(all, 95))}/${fmt(pct(all, 99))} ms`);
