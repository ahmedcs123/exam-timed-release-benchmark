// Run scheduler (design Sections 5-7). For every run it:
//   1. brings the arm up from nothing (compose down -v first: fresh chain / fresh etcd / fresh key server),
//   2. polls readiness (Besu start-up time varies, RUN_LOG 2026-11-19) with a timeout,
//   3. runs one warm-up session and discards it,
//   4. runs the measured session with the resource sampler on the arm's SERVER containers only
//      (the load generator is shared by all arms and excluded),
//   5. measures storage growth (container writable layer + its volumes), writes the record, tears the arm down.
// Arm order inside each block is shuffled with a logged seed. Discards are written to the schedule log
// with their reason and must be copied to docs/RUN_LOG.md.
//
// Run from the repo root on the host (Docker Desktop running, image etr-node:dev built):
//   node harness/scripts/run-schedule.js --phase pilot --blocks 2 --arms A,B,C
//   node harness/scripts/run-schedule.js --phase pilot --blocks 2 --arms A,B,C --dry-run
// Options: --phase smoke|pilot|raw  --blocks N  --arms A,B,C  --seed0 1000  --sched-seed 20261119
//          --m 50 --k 3 --n 5 --poll-ms 500 --exam-size 5MB --ready-timeout-s 300 --sample-ms 500
//          Fault tests (phase faults): --test F1 --present 0,1,2 --fault corrupt-share|early-submit --timeout-ms 60000
//          (these apply to the measured session only; the warm-up session is always a normal one)
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startSampler, engineGet } from '../src/docker-stats.js';

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);
const cfg = {
  phase: opt('phase', 'pilot'),
  blocks: Number(opt('blocks', 2)),
  arms: opt('arms', 'A,B,C').split(','),
  seed0: Number(opt('seed0', 1000)),
  schedSeed: Number(opt('sched-seed', 20261119)),
  m: Number(opt('m', 50)), k: Number(opt('k', 3)), n: Number(opt('n', 5)),
  pollMs: Number(opt('poll-ms', 500)), examSize: opt('exam-size', '5MB'),
  readyTimeoutS: Number(opt('ready-timeout-s', 300)), sampleMs: Number(opt('sample-ms', 500)),
  dryRun: flag('dry-run'),
  test: opt('test', null), present: opt('present', null), fault: opt('fault', null), timeoutMs: opt('timeout-ms', null),
};
if (!['smoke', 'pilot', 'raw', 'faults'].includes(cfg.phase)) throw new Error('--phase must be smoke, pilot, raw or faults');
if (cfg.arms.some((a) => !['A', 'B', 'C'].includes(a))) throw new Error('--arms takes A, B and/or C');

const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'Dockerfile.node'))) throw new Error('Run from the repo root (Dockerfile.node not found)');
const OUT = resolve(ROOT, 'results', cfg.phase);
const IMAGE = 'etr-node:dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- arms ----------
const ARMS = {
  A: {
    compose: ['-f', 'arm-a-ledger/network/generated/docker-compose.yml', '-p', 'etr-arm-a'],
    network: 'etr-arm-a_besu',
    servers: ['etr-besu1', 'etr-besu2', 'etr-besu3', 'etr-besu4'],
    env: { RPC_URLS: 'http://besu1:8545,http://besu2:8545,http://besu3:8545,http://besu4:8545' },
    // chain.js reads these two generated files at import; they are not baked into the image (gitignored,
    // regenerated per network), so they are bind-mounted read-only. Validator keys are NOT mounted.
    mounts: ['network.json', 'accounts.json'].map((f) => `${resolve(ROOT, 'arm-a-ledger/network/generated', f)}:/app/arm-a-ledger/network/generated/${f}:ro`),
    ready: readyA,
  },
  B: {
    compose: ['-f', 'arm-b-coordinator/docker-compose.yml', '-p', 'etr-arm-b', '--profile', 'bench'],
    network: 'etr-arm-b_default',
    servers: ['etr-etcd1', 'etr-etcd2', 'etr-etcd3', 'etr-coordinator'],
    env: { ENDPOINT: 'http://coordinator:8080' },
    ready: readyB,
  },
  C: {
    compose: ['-f', 'arm-c-central/docker-compose.yml', '-p', 'etr-arm-c'],
    network: 'etr-arm-c_default',
    servers: ['etr-keyserver'],
    env: { ENDPOINT: 'http://keyserver:8080' },
    ready: readyC,
  },
};

// ---------- helpers ----------
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function shAsync(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ ok: code === 0, code, out: out.trim(), err: err.trim() }));
  });
}
// Own timeout with a normal (ref'd) timer: AbortSignal.timeout() uses an unref'd timer, so while Docker
// Desktop's port proxy holds a connection open to a node that is still starting, Node saw nothing keeping
// the process alive and exited ("unsettled top-level await", pilot 2026-11-19).
async function httpStatus(url, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try { const r = await fetch(url, { ...init, signal: ac.signal }); return { status: r.status, body: await r.text() }; }
  catch { return { status: 0, body: '' }; }
  finally { clearTimeout(timer); }
}
async function rpc(url, method, params = []) {
  const r = await httpStatus(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(r.body); if (j.error) throw new Error(j.error.message); return j.result;
}
// Same rule as scripts/check-network.js: every node has >= 3 peers, sees 4 validators, and blocks are produced.
async function readyA() {
  for (const p of [18545, 18546, 18547, 18548]) {
    try {
      const u = `http://127.0.0.1:${p}`;
      const [block, peers, vals] = await Promise.all([rpc(u, 'eth_blockNumber'), rpc(u, 'net_peerCount'), rpc(u, 'qbft_getValidatorsByBlockNumber', ['latest'])]);
      if (parseInt(block, 16) < 1 || parseInt(peers, 16) < 3 || vals.length !== 4) return false;
    } catch { return false; }
  }
  return true;
}
// etcd: all 3 members healthy; coordinator answers a request that goes through etcd (404 = unknown exam).
async function readyB() {
  for (const p of [23791, 23792, 23793]) {
    const r = await httpStatus(`http://127.0.0.1:${p}/health`);
    if (r.status !== 200 || !/"health":\s*"true"/.test(r.body)) return false;
  }
  return (await httpStatus('http://127.0.0.1:18081/exams/ready-probe/shares')).status === 404;
}
async function readyC() { return (await httpStatus('http://127.0.0.1:18080/exams/ready-probe/key')).status === 404; }

// Storage of one container = writable layer (SizeRw) + size of each named/anonymous volume it mounts.
async function storageOf(names) {
  const df = await engineGet('/system/df?type=volume').catch(() => ({ Volumes: [] }));
  const vol = Object.fromEntries((df.Volumes || []).map((v) => [v.Name, v.UsageData?.Size ?? null]));
  const out = {};
  for (const n of names) {
    try {
      const c = await engineGet(`/containers/${encodeURIComponent(n)}/json?size=true`);
      const vols = (c.Mounts || []).filter((m) => m.Type === 'volume').map((m) => ({ name: m.Name, bytes: vol[m.Name] ?? null }));
      out[n] = { sizeRwBytes: c.SizeRw ?? null, volumes: vols, totalBytes: (c.SizeRw ?? 0) + vols.reduce((a, v) => a + (v.bytes ?? 0), 0) };
    } catch (e) { out[n] = { error: String(e.message) }; }
  }
  return out;
}
const sumBytes = (s) => Object.values(s).reduce((a, v) => a + (v.totalBytes ?? 0), 0);

// Seeded PRNG (mulberry32) + Fisher-Yates: arm order per block is reproducible from --sched-seed.
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(list, seed) { const r = mulberry32(seed), a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function down(arm) {
  sh('docker', ['compose', ...ARMS[arm].compose, 'down', '-v', '--remove-orphans']);
  sh('docker', ['rm', '-f', ...ARMS[arm].servers]); // in case a stack was started earlier under another project name
}
function session(arm, runId, seed, outSub, extra = {}) {
  const e = { ...extra, ARM: arm, RUN_ID: runId, SEED: String(seed), M: String(cfg.m), K: String(cfg.k), N: String(cfg.n),
    POLL_MS: String(cfg.pollMs), EXAM_SIZE: cfg.examSize, OUT_DIR: `/results/${outSub}`, ...ARMS[arm].env };
  const envArgs = Object.entries(e).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  sh('docker', ['rm', '-f', 'etr-loadgen']);
  return shAsync('docker', ['run', '--rm', '--name', 'etr-loadgen', '--network', ARMS[arm].network,
    '-v', `${OUT}:/results`, ...(ARMS[arm].mounts || []).flatMap((m) => ['-v', m]), '-w', '/app', ...envArgs, IMAGE, 'node', 'harness/src/session.js']);
}
const lastJson = (text) => { const l = text.split('\n').reverse().find((x) => x.trim().startsWith('{')); try { return l ? JSON.parse(l) : null; } catch { return null; } };

// ---------- schedule ----------
const plan = [];
for (let b = 1; b <= cfg.blocks; b++) {
  const seed = cfg.seed0 + b; // the same session material for every arm in the block (matched design)
  shuffled(cfg.arms, cfg.schedSeed + b).forEach((arm, pos) => plan.push({ block: b, pos, arm, seed, runId: `${cfg.phase}${cfg.test ? `-${cfg.test}` : ''}-b${String(b).padStart(3, '0')}-${arm}` }));
}
console.log(`Schedule (${plan.length} runs, sched-seed ${cfg.schedSeed}):`);
for (const p of plan) console.log(`  block ${p.block}  ${p.pos + 1}. arm ${p.arm}  seed ${p.seed}  ${p.runId}`);
if (cfg.dryRun) process.exit(0);

mkdirSync(join(OUT, 'warmup'), { recursive: true });
const keepAlive = setInterval(() => {}, 60_000); // safety net: the event loop never empties mid-schedule
const git = { commit: sh('git', ['rev-parse', 'HEAD']).out || null, dirty: (sh('git', ['status', '--porcelain', '--', '.', ':(exclude)results']).out || '') !== '' }; // results/ is output, not code
const imageId = sh('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']).out || null;
if (!imageId) throw new Error(`Image ${IMAGE} not found: docker build -f Dockerfile.node -t ${IMAGE} .`);
const logFile = join(OUT, 'schedule-log.jsonl');
const log = (o) => { appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); console.log(JSON.stringify(o)); };
log({ event: 'schedule-start', cfg, plan, git, imageId });
if (git.dirty) console.log('WARNING: working tree has uncommitted changes (recorded in the log). Measured runs need a clean, committed tree.');

for (const p of plan) {
  const A = ARMS[p.arm];
  const rec = { schema: 1, ...p, phase: cfg.phase, git, imageId, cell: { m: cfg.m, k: cfg.k, n: cfg.n, pollMs: cfg.pollMs, examSize: cfg.examSize }, marks: {} };
  const discard = (reason, extra = {}) => { log({ event: 'discard', runId: p.runId, arm: p.arm, block: p.block, reason, ...extra }); };
  try {
    down(p.arm);
    rec.marks.upStart = Date.now();
    const up = sh('docker', ['compose', ...A.compose, 'up', '-d']);
    if (!up.ok) { discard('compose up failed', { err: up.err.slice(-500) }); down(p.arm); continue; }
    let ready = false;
    const deadline = Date.now() + cfg.readyTimeoutS * 1000;
    while (Date.now() < deadline) { if (await A.ready()) { ready = true; break; } await sleep(3000); }
    rec.marks.ready = Date.now();
    rec.readySeconds = (rec.marks.ready - rec.marks.upStart) / 1000;
    if (!ready) { discard(`not ready after ${cfg.readyTimeoutS} s (harness error before T0)`); down(p.arm); continue; }

    // Warm-up session (discarded by design, kept only for inspection)
    const w = await session(p.arm, `${p.runId}-warmup`, p.seed, 'warmup');
    rec.warmup = { ok: w.ok, summary: lastJson(w.out) };
    if (!w.ok) { discard('warm-up session failed', { err: w.err.slice(-500) }); down(p.arm); continue; }

    // Measured session
    const storageBefore = await storageOf(A.servers);
    const sampler = startSampler(A.servers, cfg.sampleMs);
    rec.marks.sessionStart = Date.now();
    const faultEnv = Object.fromEntries(Object.entries({ TEST_ID: cfg.test, TRUSTEES_PRESENT: cfg.present, FAULT: cfg.fault, TIMEOUT_MS: cfg.timeoutMs }).filter(([, v]) => v != null));
    const s = await session(p.arm, p.runId, p.seed, '.', faultEnv);
    rec.marks.sessionEnd = Date.now();
    const resources = await sampler.stop();
    const storageAfter = await storageOf(A.servers);
    rec.session = { ok: s.ok, summary: lastJson(s.out), file: `${p.runId}.json` };
    rec.resources = {
      perContainer: resources,
      cpuSecondsTotal: Object.values(resources).reduce((a, r) => a + (r.cpuSeconds ?? 0), 0),
      memMaxBytesSum: Object.values(resources).reduce((a, r) => a + (r.memMaxBytes ?? 0), 0), // sum of per-container peaks
      samplerErrors: Object.values(resources).reduce((a, r) => a + r.errors, 0),
    };
    rec.storage = { before: storageBefore, after: storageAfter, growthBytes: sumBytes(storageAfter) - sumBytes(storageBefore) };
    writeFileSync(join(OUT, `${p.runId}.resources.json`), JSON.stringify(rec, null, 2));

    const sum = rec.session.summary;
    if (!s.ok || !sum) discard('measured session failed', { err: s.err.slice(-500) });
    else if (sum.setupOverran) discard('setup overran T0 (harness error before T0)');
    else log({ event: 'run-ok', runId: p.runId, arm: p.arm, block: p.block, L50: sum.L50, L95: sum.L95, Lmax: sum.Lmax,
      earlyCount: sum.earlyCount, okCentres: sum.okCentres, cpuSeconds: rec.resources.cpuSecondsTotal, storageGrowthBytes: rec.storage.growthBytes, readySeconds: rec.readySeconds });
  } catch (e) {
    discard('scheduler error', { err: String(e.stack || e) });
  } finally {
    down(p.arm);
  }
}
log({ event: 'schedule-end' });
clearInterval(keepAlive);
process.exit(0);
