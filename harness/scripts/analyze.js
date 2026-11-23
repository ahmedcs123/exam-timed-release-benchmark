// Analysis script (design Sections 3, 7 and 9). Regenerates every table of the paper from the saved run records:
//   results/raw/*.json + *.resources.json   (main runs)      results/faults/*  (fault tests, via check-faults.js)
// Writes results/analysis/: summary.json (everything), and one CSV per table, plus report.md (readable summary).
// Run from the repo root:  node harness/scripts/analyze.js            (no Docker needed; reads files only)
//
// Statistics exactly as pre-registered (Section 9):
//   * unit of analysis = one run; runs are paired by cell + block (same seed);
//   * H1 (primary cell only): paired D = L95(A) - L95(B); distribution-free CI for the median D from order
//     statistics (20 pairs: 6th..15th, coverage 95.86%; general n: widest-coverage pair >= 95%); non-inferior if the
//     upper bound < delta = 5 s; one-sided sign test of (D - delta); Wilcoxon signed-rank (exact) as a secondary check;
//   * every metric: median A, median B, median paired difference (A - B), median paired ratio (A / B), each with a 95%
//     percentile bootstrap CI (10,000 resamples of pairs, fixed seed);
//   * sensitivity cells: descriptive only (no p-values);  H1b: early-release count over all runs of all cells.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const RAW = join(ROOT, 'results', 'raw');
const OUT = join(ROOT, 'results', 'analysis');
if (!existsSync(join(ROOT, 'Dockerfile.node'))) throw new Error('Run from the repo root');
mkdirSync(OUT, { recursive: true });

const DELTA_MS = 5000;              // H1 margin (Section 3)
const BOOT = 10000, BOOT_SEED = 20261118;
// Normalisation bounds (Section 7), used only to flag values outside the plausible range
const BOUNDS = { L95_s: [0, 120], cpu_s: [0, 600], mem_MB: [0, 10000], storage_MB: [0, 100], shareLag_s: [0, 60] };

// ---------- small exact statistics ----------
const median = (xs) => { const a = [...xs].sort((p, q) => p - q); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; };
function binomCdf(k, n) { // P(X <= k), X ~ Bin(n, 0.5), exact with BigInt
  if (k < 0) return 0; if (k >= n) return 1;
  let c = 1n, s = 0n; for (let i = 0; i <= k; i++) { s += c; c = (c * BigInt(n - i)) / BigInt(i + 1); }
  return Number((s * 10n ** 18n) / (2n ** BigInt(n))) / 1e18;
}
// Distribution-free CI for the median: [x_(j), x_(n-j+1)] with the largest j whose coverage is >= 95%.
function medianCI(xs) {
  const a = [...xs].sort((p, q) => p - q), n = a.length;
  let best = null;
  for (let j = 1; j <= Math.floor(n / 2); j++) { const cov = 1 - 2 * binomCdf(j - 1, n); if (cov >= 0.95) best = { j, coverage: cov }; }
  if (!best) return { n, lower: null, upper: null, coverage: null, ranks: null };
  return { n, lower: a[best.j - 1], upper: a[n - best.j], coverage: best.coverage, ranks: [best.j, n - best.j + 1] };
}
// One-sided sign test of H0: median(D) >= delta against H1: median(D) < delta (ties at delta dropped).
function signTestBelow(ds, delta) {
  const d = ds.map((x) => x - delta).filter((x) => x !== 0), n = d.length, below = d.filter((x) => x < 0).length;
  return { n, below, p: n ? 1 - binomCdf(below - 1, n) : null }; // P(X >= below)
}
// Exact one-sided Wilcoxon signed-rank test on (D - delta) < 0 (secondary check). Ranks with midranks for ties.
function wilcoxonBelow(ds, delta) {
  const d = ds.map((x) => x - delta).filter((x) => x !== 0), n = d.length;
  const order = d.map((x, i) => [Math.abs(x), i]).sort((p, q) => p[0] - q[0]);
  const rank = new Array(n);
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && order[j + 1][0] === order[i][0]) j++; for (let k = i; k <= j; k++) rank[order[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  const wMinus = d.reduce((s, x, i) => s + (x < 0 ? rank[i] : 0), 0);
  // exact null distribution of W+ for ranks 1..n (no-tie approximation of the ranks, doubled to integers)
  const max = n * (n + 1); const dist = new Array(max + 1).fill(0); dist[0] = 1;
  for (let r = 1; r <= n; r++) for (let s = max; s >= 2 * r; s--) dist[s] += dist[s - 2 * r];
  const total = 2 ** n, wPlus2 = Math.round(2 * (n * (n + 1) / 2 - wMinus));
  let p = 0; for (let s = 0; s <= wPlus2; s++) p += dist[s] / total; // P(W+ <= observed): small W+ = mostly below delta
  return { n, wMinus, p };
}
// Seeded PRNG (mulberry32) for the bootstrap
const prng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function bootCI(pairs, stat) { // percentile bootstrap over pairs
  if (pairs.length < 2) return [null, null];
  const r = prng(BOOT_SEED), vals = [];
  for (let b = 0; b < BOOT; b++) { const s = []; for (let i = 0; i < pairs.length; i++) s.push(pairs[Math.floor(r() * pairs.length)]); vals.push(stat(s)); }
  vals.sort((p, q) => p - q);
  return [vals[Math.floor(0.025 * BOOT)], vals[Math.ceil(0.975 * BOOT) - 1]];
}

// ---------- load runs ----------
const runs = [];
for (const f of existsSync(RAW) ? readdirSync(RAW).filter((x) => x.endsWith('.resources.json')) : []) {
  const res = JSON.parse(readFileSync(join(RAW, f), 'utf8'));
  const sf = join(RAW, f.replace('.resources.json', '.json'));
  if (!existsSync(sf)) continue;
  const s = JSON.parse(readFileSync(sf, 'utf8'));
  const kept = res.session?.ok === true && s.summary && !s.summary.setupOverran;
  const m = res.runId.match(/^raw-(.+)-b(\d{3})-([ABC])$/);
  if (!m) continue;
  const okTrustees = s.trustees.filter((t) => t.ok).map((t) => t.doneAtMs - s.t0Ms).sort((p, q) => p - q);
  runs.push({
    runId: res.runId, cell: m[1], block: Number(m[2]), arm: m[3], kept, seed: res.seed,
    L50: s.summary.L50, L95: s.summary.L95, Lmax: s.summary.Lmax, earlyCount: s.summary.earlyCount,
    okCentres: s.summary.okCentres, m: s.config.m, completion60s: s.summary.completion60s,
    cpu_s: res.resources?.cpuSecondsTotal ?? null,
    mem_MB: res.resources?.memMaxBytesSum != null ? res.resources.memMaxBytesSum / 2 ** 20 : null, // sum of per-container peaks
    storage_MB: res.storage?.growthBytes != null ? res.storage.growthBytes / 1e6 : null,
    // share-availability lag: time the k-th share was stored (receipt / HTTP 201 at the trustee) minus T0
    shareLag_s: okTrustees.length >= s.config.k ? okTrustees[s.config.k - 1] / 1000 : null,
    gasSubmissions: res.arm === 'A' ? s.trustees.reduce((a, t) => a + (t.gasUsed || 0), 0) : null,
    samplerErrors: res.resources?.samplerErrors ?? null, readySeconds: res.readySeconds,
    blockPeriodOk: res.blockPeriodCheck ? res.blockPeriodCheck.ok : null,
  });
}
const kept = runs.filter((r) => r.kept);
const cells = [...new Set(kept.map((r) => r.cell))].sort((a, b) => (a === 'P' ? -1 : b === 'P' ? 1 : a.localeCompare(b)));
const pairsOf = (cell, x = 'A', y = 'B') => {
  const by = {}; for (const r of kept.filter((q) => q.cell === cell)) (by[r.block] ??= {})[r.arm] = r;
  return Object.values(by).filter((b) => b[x] && b[y]).map((b) => [b[x], b[y]]);
};

// ---------- tables ----------
const METRICS = [
  ['L95', 'L95 (ms)'], ['L50', 'L50 (ms)'], ['Lmax', 'Lmax (ms)'], ['shareLag_s', 'Share-availability lag (s)'],
  ['cpu_s', 'CPU-seconds per session'], ['mem_MB', 'Peak memory, sum of per-container peaks (MB)'], ['storage_MB', 'Storage growth (MB)'],
];
function effect(pairs, key) {
  const p = pairs.filter(([a, b]) => a[key] != null && b[key] != null).map(([a, b]) => [a[key], b[key]]);
  const ratioOk = p.every(([, b]) => b !== 0);
  const mA = (s) => median(s.map((x) => x[0])), mB = (s) => median(s.map((x) => x[1]));
  const mD = (s) => median(s.map((x) => x[0] - x[1])), mR = (s) => median(s.map((x) => x[0] / x[1]));
  return {
    n: p.length, medianA: mA(p), ciA: bootCI(p, mA), medianB: mB(p), ciB: bootCI(p, mB),
    medianDiff: mD(p), ciDiff: bootCI(p, mD), exactDiff: medianCI(p.map((x) => x[0] - x[1])),
    medianRatio: ratioOk && p.length ? mR(p) : null, ciRatio: ratioOk ? bootCI(p, mR) : [null, null],
  };
}
const summary = { generatedAt: new Date().toISOString(), deltaMs: DELTA_MS, bootstrap: { resamples: BOOT, seed: BOOT_SEED }, runs: { total: runs.length, kept: kept.length, notKept: runs.filter((r) => !r.kept).map((r) => r.runId) }, cells: {} };

// H1 (primary cell only)
const pP = pairsOf('P');
const D = pP.map(([a, b]) => a.L95 - b.L95);
const ci = medianCI(D);
summary.H1 = {
  pairs: D.length, differencesMs: D, medianDiffMs: median(D), exactCI: ci,
  nonInferior: ci.upper != null ? ci.upper < DELTA_MS : null,
  decision: ci.upper == null ? 'not enough pairs' : ci.upper < DELTA_MS ? 'non-inferior (CI upper bound < delta)' : 'non-inferiority not shown',
  signTest: signTestBelow(D, DELTA_MS), wilcoxon: wilcoxonBelow(D, DELTA_MS),
  bootstrapCI: bootCI(pP.map(([a, b]) => [a.L95, b.L95]), (s) => median(s.map((x) => x[0] - x[1]))),
};

// H1b (all cells, all arms)
summary.H1b = Object.fromEntries(['A', 'B', 'C'].map((arm) => {
  const rs = kept.filter((r) => r.arm === arm), early = rs.filter((r) => r.earlyCount > 0);
  return [arm, { runs: rs.length, runsWithEarlyKey: early.length, earlyRunIds: early.map((r) => r.runId), pass: early.length === 0 }];
}));

// Per-cell effects (A vs B), C vs B in the primary cell
for (const cell of cells) {
  const pr = pairsOf(cell);
  summary.cells[cell] = { pairs: pr.length, metrics: Object.fromEntries(METRICS.map(([k]) => [k, effect(pr, k)])),
    allCentresGotKey: { A: pr.every(([a]) => a.okCentres === a.m), B: pr.every(([, b]) => b.okCentres === b.m) } };
}
const pC = pairsOf('P', 'C', 'B');
summary.referenceC = { pairs: pC.length, metrics: Object.fromEntries(METRICS.map(([k]) => [k, effect(pC, k)])) };
// Gas (A only): share submissions per session (deploy and registration gas are not in the run records)
summary.gas = Object.fromEntries(cells.map((c) => { const g = kept.filter((r) => r.cell === c && r.arm === 'A').map((r) => r.gasSubmissions); return [c, { runs: g.length, median: median(g), min: Math.min(...g), max: Math.max(...g) }]; }));
// Values outside the normalisation bounds (flagged, not removed)
summary.outOfBounds = kept.flatMap((r) => Object.entries(BOUNDS).flatMap(([k, [lo, hi]]) => {
  const v = k === 'L95_s' ? (r.L95 == null ? null : r.L95 / 1000) : r[k];
  return v != null && (v < lo || v > hi) ? [{ runId: r.runId, metric: k, value: v }] : [];
}));
summary.quality = { samplerErrors: kept.reduce((a, r) => a + (r.samplerErrors || 0), 0), blockPeriodChecksFailed: kept.filter((r) => r.blockPeriodOk === false).map((r) => r.runId) };

// Fault tests (RQ2): refresh verdicts with the existing checker, then read them
if (existsSync(join(ROOT, 'results', 'faults'))) {
  spawnSync(process.execPath, ['harness/scripts/check-faults.js'], { cwd: ROOT, stdio: 'ignore' });
  const vf = join(ROOT, 'results', 'faults', 'fault-verdicts.json');
  if (existsSync(vf)) summary.faults = JSON.parse(readFileSync(vf, 'utf8')).results.map(({ test, arm, valid, passed, verdict }) => ({ test, arm, passed, valid, verdict }));
}

// ---------- outputs ----------
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '' : Number(x).toFixed(d));
const csv = (rows) => rows.map((r) => r.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(',')).join('\n') + '\n';
writeFileSync(join(OUT, 'runs.csv'), csv([['runId', 'cell', 'block', 'arm', 'kept', 'L50_ms', 'L95_ms', 'Lmax_ms', 'earlyCount', 'okCentres', 'M', 'shareLag_s', 'cpu_s', 'mem_MB', 'storage_MB', 'gasSubmissions', 'readySeconds'],
  ...runs.sort((a, b) => a.runId.localeCompare(b.runId)).map((r) => [r.runId, r.cell, r.block, r.arm, r.kept, r.L50, r.L95, r.Lmax, r.earlyCount, r.okCentres, r.m, f(r.shareLag_s, 3), f(r.cpu_s, 2), f(r.mem_MB, 1), f(r.storage_MB, 3), r.gasSubmissions ?? '', f(r.readySeconds, 1)])]));
const effRows = [['cell', 'metric', 'n_pairs', 'median_A', 'A_CI_lo', 'A_CI_hi', 'median_B', 'B_CI_lo', 'B_CI_hi', 'median_diff_A_minus_B', 'diff_boot_lo', 'diff_boot_hi', 'diff_exact_lo', 'diff_exact_hi', 'exact_coverage', 'median_ratio_A_over_B', 'ratio_lo', 'ratio_hi']];
for (const cell of cells) for (const [k] of METRICS) { const e = summary.cells[cell].metrics[k]; effRows.push([cell, k, e.n, f(e.medianA, 3), f(e.ciA[0], 3), f(e.ciA[1], 3), f(e.medianB, 3), f(e.ciB[0], 3), f(e.ciB[1], 3), f(e.medianDiff, 3), f(e.ciDiff[0], 3), f(e.ciDiff[1], 3), f(e.exactDiff.lower, 3), f(e.exactDiff.upper, 3), f(e.exactDiff.coverage, 4), f(e.medianRatio, 3), f(e.ciRatio[0], 3), f(e.ciRatio[1], 3)]); }
writeFileSync(join(OUT, 'effects_A_vs_B.csv'), csv(effRows));
if (summary.faults) writeFileSync(join(OUT, 'faults.csv'), csv([['test', 'arm', 'passed', 'valid', 'verdict'], ...summary.faults.map((x) => [x.test, x.arm, x.passed, x.valid, x.verdict])]));

const h = summary.H1, L = [];
L.push('# Analysis report (generated by harness/scripts/analyze.js)', '', `Generated ${summary.generatedAt}. Runs read: ${runs.length}, kept: ${kept.length}.`, '');
L.push('## H1 (primary cell P): paired difference D = L95(A) - L95(B)', '');
L.push(`Pairs: ${h.pairs}. Median D = ${f(h.medianDiffMs, 0)} ms. Distribution-free CI (order statistics ${h.exactCI.ranks?.join(' and ')}, coverage ${f(100 * h.exactCI.coverage, 2)} %): [${f(h.exactCI.lower, 0)}, ${f(h.exactCI.upper, 0)}] ms. Margin delta = ${DELTA_MS} ms.`);
L.push(`Decision: **${h.decision}**. One-sided sign test of (D - delta): ${h.signTest.below}/${h.signTest.n} below, p = ${h.signTest.p?.toExponential(2)}. Wilcoxon signed-rank (secondary): p = ${h.wilcoxon.p?.toExponential(2)}. Bootstrap 95 % CI of median D: [${f(h.bootstrapCI[0], 0)}, ${f(h.bootstrapCI[1], 0)}] ms.`, '');
L.push('## H1b: early key release (all cells)', '', ...Object.entries(summary.H1b).map(([a, v]) => `- Arm ${a}: ${v.runsWithEarlyKey} of ${v.runs} runs with any centre holding the key before T0${v.earlyRunIds.length ? ` (${v.earlyRunIds.join(', ')})` : ''}.`), '');
L.push('## Effects A vs B per cell (median A, median B, median paired difference, median ratio; 95 % bootstrap CI)', '');
for (const cell of cells) {
  L.push(`### ${cell} (${summary.cells[cell].pairs} pairs)${cell === 'P' ? '' : ' - descriptive only'}`, '', '| Metric | A | B | A - B | A / B |', '|---|---|---|---|---|');
  for (const [k, label] of METRICS) { const e = summary.cells[cell].metrics[k]; if (!e.n) continue;
    L.push(`| ${label} | ${f(e.medianA, 2)} [${f(e.ciA[0], 2)}, ${f(e.ciA[1], 2)}] | ${f(e.medianB, 2)} [${f(e.ciB[0], 2)}, ${f(e.ciB[1], 2)}] | ${f(e.medianDiff, 2)} [${f(e.ciDiff[0], 2)}, ${f(e.ciDiff[1], 2)}] | ${e.medianRatio == null ? 'n/a' : `${f(e.medianRatio, 2)} [${f(e.ciRatio[0], 2)}, ${f(e.ciRatio[1], 2)}]`} |`); }
  L.push('');
}
L.push('## Gas per session, arm A (n share submissions only)', '', ...Object.entries(summary.gas).map(([c, g]) => `- ${c}: median ${g.median} (min ${g.min}, max ${g.max}), ${g.runs} runs`), '');
if (summary.faults) L.push('## Fault tests (RQ2)', '', '| Test | Arm | Passed | Verdict |', '|---|---|---|---|', ...summary.faults.map((x) => `| ${x.test} | ${x.arm} | ${x.passed}/${x.valid} | ${x.verdict} |`), '');
L.push('## Data quality', '', `Runs not kept: ${summary.runs.notKept.length ? summary.runs.notKept.join(', ') : 'none'}. Sampler errors: ${summary.quality.samplerErrors}. Failed block-period checks among kept runs: ${summary.quality.blockPeriodChecksFailed.length}. Values outside normalisation bounds: ${summary.outOfBounds.length ? summary.outOfBounds.map((o) => `${o.runId} ${o.metric}=${f(o.value, 2)}`).join('; ') : 'none'}.`, '');
L.push('Notes: peak memory is the sum of each container\'s own peak (an upper bound of the peak of the summed memory, which the records do not hold). Share-availability lag uses the time each trustee received its receipt / HTTP 201. Gas covers the share submissions recorded per run; contract deployment and registration gas are not in the run records.');
writeFileSync(join(OUT, 'report.md'), L.join('\n') + '\n');
console.log(`Runs read ${runs.length}, kept ${kept.length}. H1: ${h.decision} (pairs ${h.pairs}, median D ${f(h.medianDiffMs, 0)} ms, exact CI [${f(h.exactCI.lower, 0)}, ${f(h.exactCI.upper, 0)}] ms). Outputs in results/analysis/.`);
