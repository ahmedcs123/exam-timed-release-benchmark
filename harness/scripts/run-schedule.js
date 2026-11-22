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
//          --censor 0,10,20,30,40 (F6; in B the coordinator is started with CENSOR_CENTRES, which also affects the
//          discarded warm-up)  --kill-at-t0 (F7: docker kill of etr-besu4 / etr-etcd3 at T0 of the measured session)
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
  censor: opt('censor', null), killAtT0: flag('kill-at-t0'),
  clockSkewMs: Number(opt('clock-skew-ms', 0)), trusteeMode: opt('trustee-mode', null), t0DelayMs: opt('t0-delay-ms', null),
  // Sensitivity cells (design Section 6): trustee jitter, background load, block period (A only); --resume skips runs
  // whose record already exists in the output folder (so a schedule can be continued on another night).
  jitterMaxMs: opt('jitter-max-ms', null), bgRps: opt('bg-rps', null), blockPeriod: Number(opt('block-period', 2)), resume: flag('resume'),
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
    // Fixed validator IPs (generated compose), not container names: after a node is killed (F7) its name no longer
    // resolves and DNS look-ups slowed every centre in the load generator (smoke 2026-11-20). Same nodes as before.
    env: { RPC_URLS: 'http://172.28.0.11:8545,http://172.28.0.12:8545,http://172.28.0.13:8545,http://172.28.0.14:8545' },
    killTarget: 'etr-besu4', // F7: 1 of 4 validators
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
    killTarget: 'etr-etcd3', // F7: 1 of 3 etcd replicas
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
function sh(cmd, args, extraEnv = null) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}) });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function shAsync(cmd, args, onLine = null) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT });
    let out = '', err = '', partial = '';
    p.stdout.on('data', (d) => { out += d; });
    if (onLine) p.stdout.on('data', (d) => { const parts = (partial + d).split('\n'); partial = parts.pop(); parts.forEach(onLine); });
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

// F5 manipulation check for A: Besu writes its own (JVM) time at the start of every log line and Docker adds the
// real time with --timestamps; the median difference over recent lines is the node's clock offset.
function logOffsetS(container) {
  const r = sh('docker', ['logs', '--timestamps', '--tail', '60', container]);
  const offs = [];
  const samples = [];
  for (const raw of `${r.out}\n${r.err}`.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, ''); // strip colour codes
    const d = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z\s+(.*)$/); // Docker's real time
    if (!d) continue;
    const real = Date.parse(`${d[1]}${(d[2] || '').slice(0, 4)}Z`);
    // Besu's own time near the start of the line: with or without a date, with or without a zone (UTC if none)
    const j = d[3].slice(0, 45).match(/(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2}:\d{2})([.,]\d{1,3})?\d*\s*([+-]\d{2}:?\d{2}|Z)?/);
    if (!j) continue;
    const tz = !j[4] || j[4] === 'Z' ? 'Z' : (j[4].includes(':') ? j[4] : `${j[4].slice(0, 3)}:${j[4].slice(3)}`);
    const day = j[1] || d[1].slice(0, 10);
    let jvm = Date.parse(`${day}T${j[2]}${(j[3] || '').replace(',', '.')}${tz}`);
    if (!j[1] && Number.isFinite(jvm)) { while (jvm - real > 43_200_000) jvm -= 86_400_000; while (real - jvm > 43_200_000) jvm += 86_400_000; }
    if (Number.isFinite(real) && Number.isFinite(jvm)) { offs.push((jvm - real) / 1000); if (samples.length < 2) samples.push(line.slice(0, 120)); }
  }
  offs.sort((x, y) => x - y);
  const firstLines = `${r.out}\n${r.err}`.split('\n').filter(Boolean).slice(-2).map((x) => x.slice(0, 120));
  return { lines: offs.length, medianS: offs.length ? offs[Math.floor(offs.length / 2)] : null, samples: samples.length ? samples : firstLines };
}
function skewCheck(arm, skewMs) {
  if (arm === 'A') {
    const skewed = logOffsetS('etr-besu4'), honest = logOffsetS('etr-besu1'), want = skewMs / 1000;
    return { arm, wantS: want, besu4: skewed, besu1: honest,
      ok: skewed.medianS != null && honest.medianS != null && Math.abs(skewed.medianS - want) <= 5 && Math.abs(honest.medianS) <= 2 };
  }
  const env = sh('docker', ['inspect', 'etr-coordinator', '--format', '{{json .Config.Env}}']).out;
  return { arm, configured: env.includes(`CLOCK_SKEW_MS=${skewMs}`), ok: env.includes(`CLOCK_SKEW_MS=${skewMs}`) };
}

function down(arm) {
  sh('docker', ['compose', ...ARMS[arm].compose, 'down', '-v', '--remove-orphans']);
  sh('docker', ['rm', '-f', ...ARMS[arm].servers]); // in case a stack was started earlier under another project name
}
function session(arm, runId, seed, outSub, extra = {}, onLine = null) {
  const e = { ...extra, ARM: arm, RUN_ID: runId, SEED: String(seed), M: String(cfg.m), K: String(cfg.k), N: String(cfg.n),
    POLL_MS: String(cfg.pollMs), EXAM_SIZE: cfg.examSize, OUT_DIR: `/results/${outSub}`, ...ARMS[arm].env };
  const envArgs = Object.entries(e).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  sh('docker', ['rm', '-f', 'etr-loadgen']);
  return shAsync('docker', ['run', '--rm', '--name', 'etr-loadgen', '--network', ARMS[arm].network,
    '-v', `${OUT}:/results`, ...(ARMS[arm].mounts || []).flatMap((m) => ['-v', m]), '-w', '/app', ...envArgs, IMAGE, 'node', 'harness/src/session.js'], onLine);
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
  // --resume: skip only runs that finished and were kept (the resources record is written last; a discarded or
  // interrupted run has no complete record and is run again).
  if (cfg.resume) {
    let done = false;
    try { const prev = JSON.parse(readFileSync(join(OUT, `${p.runId}.resources.json`), 'utf8')); done = prev.session?.ok === true && prev.session?.summary != null && !prev.session.summary.setupOverran; } catch { /* no record */ }
    if (done) { log({ event: 'skip-existing', runId: p.runId }); continue; }
  }
  try {
    down(p.arm);
    rec.marks.upStart = Date.now();
    // F5: B's coordinator gets CLOCK_SKEW_MS; A's besu4 runs the libfaketime image (extra compose file)
    const upEnv = { ...(p.arm === 'B' && cfg.censor ? { CENSOR_CENTRES: cfg.censor } : {}),
      ...(cfg.clockSkewMs ? (p.arm === 'B' ? { CLOCK_SKEW_MS: String(cfg.clockSkewMs) } : { CLOCK_SKEW_S: String(Math.round(cfg.clockSkewMs / 1000)) }) : {}) };
    let upFiles = p.arm === 'A' && cfg.clockSkewMs ? [...A.compose.slice(0, 2), '-f', 'arm-a-ledger/docker/f5-skew.override.yml', ...A.compose.slice(2)] : A.compose;
    // Block-period cell (A only): extra compose file that mounts the genesis with the other block period
    if (p.arm === 'A' && cfg.blockPeriod !== 2) {
      const bpFile = `arm-a-ledger/network/generated/bp${cfg.blockPeriod}.override.yml`;
      if (!existsSync(join(ROOT, bpFile))) sh('node', ['arm-a-ledger/scripts/gen-block-period.js', String(cfg.blockPeriod)]);
      if (!existsSync(join(ROOT, bpFile))) { discard(`missing ${bpFile}`); continue; }
      upFiles = [...upFiles.slice(0, 2), '-f', bpFile, ...upFiles.slice(2)];
    }
    const up = sh('docker', ['compose', ...upFiles, 'up', '-d'], Object.keys(upEnv).length ? upEnv : null);
    if (!up.ok) { discard('compose up failed', { err: up.err.slice(-500) }); down(p.arm); continue; }
    let ready = false;
    const deadline = Date.now() + cfg.readyTimeoutS * 1000;
    while (Date.now() < deadline) { if (await A.ready()) { ready = true; break; } await sleep(3000); }
    rec.marks.ready = Date.now();
    rec.readySeconds = (rec.marks.ready - rec.marks.upStart) / 1000;
    if (!ready) { discard(`not ready after ${cfg.readyTimeoutS} s (harness error before T0)`); down(p.arm); continue; }
    // Block-period check (every A run): median gap between the timestamps of the last 7 blocks must equal the
    // configured period (+/- 0.5 s); a run where it does not is a harness error before T0.
    if (p.arm === 'A') {
      try {
        const u = 'http://127.0.0.1:18545';
        let head = parseInt(await rpc(u, 'eth_blockNumber'), 16);
        for (let w = 0; head < 4 && w < 60; w++) { await sleep(1000); head = parseInt(await rpc(u, 'eth_blockNumber'), 16); }
        const ts = [];
        // block 0 (genesis, timestamp 0) is excluded
        for (let b = Math.max(1, head - 6); b <= head; b++) ts.push(parseInt((await rpc(u, 'eth_getBlockByNumber', [`0x${b.toString(16)}`, false])).timestamp, 16));
        const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((x, y) => x - y);
        const medianS = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
        rec.blockPeriodCheck = { wantS: cfg.blockPeriod, gaps, medianS, ok: medianS != null && Math.abs(medianS - cfg.blockPeriod) <= 0.5 };
      } catch (e) { rec.blockPeriodCheck = { wantS: cfg.blockPeriod, ok: false, err: String(e.message) }; }
      if (!rec.blockPeriodCheck.ok) { discard('block period not in effect (harness error before T0)', { blockPeriodCheck: rec.blockPeriodCheck }); down(p.arm); continue; }
    }
    if (cfg.clockSkewMs) {
      rec.skewCheck = skewCheck(p.arm, cfg.clockSkewMs);
      if (!rec.skewCheck.ok) { discard('clock skew not in effect (harness error before T0)', { skewCheck: rec.skewCheck }); down(p.arm); continue; }
    }

    // Warm-up session (discarded by design, kept only for inspection)
    const w = await session(p.arm, `${p.runId}-warmup`, p.seed, 'warmup');
    rec.warmup = { ok: w.ok, summary: lastJson(w.out) };
    if (!w.ok) { discard('warm-up session failed', { err: w.err.slice(-500) }); down(p.arm); continue; }

    // Measured session
    const storageBefore = await storageOf(A.servers);
    const sampler = startSampler(A.servers, cfg.sampleMs);
    rec.marks.sessionStart = Date.now();
    const faultEnv = Object.fromEntries(Object.entries({ TEST_ID: cfg.test, TRUSTEES_PRESENT: cfg.present, FAULT: cfg.fault, TIMEOUT_MS: cfg.timeoutMs, CENSORED: cfg.censor, TRUSTEE_MODE: cfg.trusteeMode, T0_DELAY_MS: cfg.t0DelayMs, JITTER_MAX_MS: cfg.jitterMaxMs, BG_LOAD_RPS: cfg.bgRps }).filter(([, v]) => v != null));
    // F7: kill one replica at T0 of the measured session (T0 comes from the session's setup-done line)
    let killTimer = null;
    const onLine = !cfg.killAtT0 ? null : (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m?.event !== 'setup-done' || rec.kill) return;
      rec.kill = { container: A.killTarget, plannedAtMs: m.t0Ms, t0Ms: m.t0Ms };
      killTimer = setTimeout(async () => {
        rec.kill.startedAtMs = Date.now();
        const k = await shAsync('docker', ['kill', A.killTarget]);
        rec.kill.killedAtMs = Date.now(); rec.kill.ok = k.ok; if (!k.ok) rec.kill.err = k.err.slice(-300);
      }, Math.max(0, m.t0Ms - Date.now()));
    };
    const s = await session(p.arm, p.runId, p.seed, '.', faultEnv, onLine);
    if (killTimer && !rec.kill?.startedAtMs) { clearTimeout(killTimer); rec.kill.ok = false; rec.kill.err = 'session ended before T0'; }
    while (rec.kill?.startedAtMs && rec.kill.killedAtMs == null) await sleep(100);
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
