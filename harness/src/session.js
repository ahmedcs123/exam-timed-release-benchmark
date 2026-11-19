// One exam session for one arm, run inside the load-generator container (same code for all arms).
// Config from env: ARM (A|B|C), RUN_ID, SEED, M, K, N, POLL_MS, EXAM_SIZE, T0_DELAY_MS, TIMEOUT_MS,
// TRUSTEES_PRESENT (e.g. "0,2,4"), RETRY_MS, OUT_DIR, ENDPOINT (B/C service URL), RPC_URLS (A).
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  generateExam, parseSize, sha256Hex, deriveExamKey, encryptExam, decryptExam, splitKey, commitShare,
  generateTrusteeKeys, runCentre, nowMs,
} from '../../shared/src/index.js';

const env = process.env;
const cfg = {
  arm: env.ARM,
  runId: env.RUN_ID || `${env.ARM}-${Date.now()}`,
  seed: Number(env.SEED ?? 42),
  m: Number(env.M ?? 50),
  k: Number(env.K ?? 3),
  n: Number(env.N ?? 5),
  pollMs: Number(env.POLL_MS ?? 500),
  examSize: env.EXAM_SIZE ?? '5MB',
  t0DelayMs: Number(env.T0_DELAY_MS ?? 15000),
  timeoutMs: Number(env.TIMEOUT_MS ?? 120000),
  retryMs: Number(env.RETRY_MS ?? 250),
  present: env.TRUSTEES_PRESENT ? env.TRUSTEES_PRESENT.split(',').map(Number) : null,
  outDir: env.OUT_DIR ?? '/results',
  endpoint: env.ENDPOINT,
};
if (!['A', 'B', 'C'].includes(cfg.arm)) throw new Error('ARM must be A, B or C');
const present = cfg.present ?? Array.from({ length: cfg.n }, (_, i) => i);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = { start: nowMs() };

// 1. Session material (identical for all arms)
const examId = `e-${randomUUID()}`;
const exam = generateExam(cfg.seed, parseSize(cfg.examSize));
const key = deriveExamKey(cfg.seed);
const encryptedExam = encryptExam(exam, key);
const expectedSha256 = sha256Hex(exam);
const shares = await splitKey(key, cfg.n, cfg.k);
const commitments = shares.map((s, i) => commitShare(examId, i, s));
marks.materialReady = nowMs();

// 2. T0 on a whole second (contract time is in seconds; same rule for every arm)
const t0Ms = Math.ceil((nowMs() + cfg.t0DelayMs) / 1000) * 1000;

// 3. Arm-specific setup and channel
let fetcherFor, submitAt;
if (cfg.arm === 'C') {
  const c = await import('../../arm-c-central/src/client.js');
  await c.registerExam(cfg.endpoint, examId, key, t0Ms);
  fetcherFor = () => c.keyFetcher(cfg.endpoint, examId);
  submitAt = async () => []; // no trustees in the central arm
} else if (cfg.arm === 'B') {
  const b = await import('../../arm-b-coordinator/src/client.js');
  const trustees = shares.map(() => generateTrusteeKeys());
  const meta = { t0Ms, k: cfg.k, n: cfg.n, commitments, trusteePublicKeys: trustees.map((t) => t.publicKey.export({ type: 'spki', format: 'pem' })) };
  await b.registerExam(cfg.endpoint, examId, meta);
  fetcherFor = (i) => b.shareFetcher(cfg.endpoint, examId, meta, i);
  submitAt = () => Promise.all(present.map(async (i) => {
    const sentAtMs = nowMs(); let attempts = 0, status;
    do {
      attempts++;
      status = await b.submitShare(cfg.endpoint, examId, i, shares[i], trustees[i].privateKey);
      if (status !== 425) break;
      await sleep(cfg.retryMs);
    } while (nowMs() < t0Ms + cfg.timeoutMs);
    return { index: i, ok: status === 201, status, attempts, sentAtMs, doneAtMs: nowMs() };
  }));
} else {
  const chain = await import('../../arm-a-ledger/src/chain.js');
  const a = await import('../../arm-a-ledger/src/client.js');
  const urls = chain.rpcUrls;
  const registrar = chain.wallet(0, urls[0]);
  const { address } = await chain.deploy(registrar);
  const meta = { t0Ms, k: cfg.k, n: cfg.n, commitments };
  const trusteeAccounts = Array.from({ length: cfg.n }, (_, i) => 1 + i);
  await chain.registerExam(address, registrar, examId, meta, trusteeAccounts);
  fetcherFor = (i) => a.shareFetcher([urls[i % urls.length]], address, examId, meta);
  submitAt = () => Promise.all(present.map(async (i) => {
    const sentAtMs = nowMs();
    const r = await a.submitWhenAllowed(address, chain.wallet(1 + i, urls[i % urls.length]), examId, i, shares[i], { retryMs: cfg.retryMs, timeoutMs: cfg.timeoutMs });
    return { index: i, ok: r.ok, reason: r.reason ?? null, gasUsed: r.gasUsed ? Number(r.gasUsed) : null, attempts: r.attempts, sentAtMs, doneAtMs: nowMs() };
  }));
}
marks.setupDone = nowMs();
const setupOverran = marks.setupDone >= t0Ms; // harness error before T0 -> run is discarded (design Section 6)

// 4. Centres start polling now with a fixed, seeded phase offset in [0, POLL_MS), so their polls are
//    spread over the polling interval instead of all firing together; trustees act at T0.
// Evenly spaced over the interval, rotated by a seed-derived fraction: centre i starts at
// ((i / M + r) mod 1) * POLL_MS, so the M centres cover the whole polling interval.
const rot = ((cfg.seed * 0.6180339887498949) % 1 + 1) % 1;
const phaseMs = (i) => Math.floor((((i / cfg.m) + rot) % 1) * cfg.pollMs);
const centresP = Promise.all(Array.from({ length: cfg.m }, async (_, i) => { await sleep(phaseMs(i)); return runCentre({
  centreId: i, t0Ms, encryptedExam, expectedSha256, obtainKey: fetcherFor(i), pollMs: cfg.pollMs, timeoutMs: cfg.timeoutMs,
  expectedKeySha256: sha256Hex(key),
}); }));
await sleep(Math.max(0, t0Ms - nowMs()));
const trustees = await submitAt();
const centres = await centresP;
marks.end = nowMs();

// Correctness oracle after the timed window: decrypt the exam once with the released key (Section 7).
let decryptOracleOk = null;
if (centres.some((c) => c.ok)) {
  try { decryptOracleOk = sha256Hex(decryptExam(encryptedExam, key)) === expectedSha256; } catch { decryptOracleOk = false; }
}

// 5. Summary (Section 7 metrics that the load generator can see)
const lat = centres.filter((c) => c.ok).map((c) => c.latencyMs).sort((x, y) => x - y);
const pct = (p) => (lat.length ? lat[Math.ceil(p * lat.length) - 1] : null);
const summary = {
  L50: pct(0.5), L95: pct(0.95), Lmax: lat.length ? lat.at(-1) : null,
  completion60s: centres.filter((c) => c.ok && c.latencyMs <= 60_000).length / cfg.m,
  earlyCount: centres.filter((c) => c.early).length,
  okCentres: lat.length,
  setupOverran,
  decryptOracleOk,
};
const record = { schema: 1, config: { ...cfg, present }, examId, t0Ms, marks, summary, trustees, centres };
mkdirSync(cfg.outDir, { recursive: true });
const file = `${cfg.outDir}/${cfg.runId}.json`;
writeFileSync(file, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ file, arm: cfg.arm, ...summary }));
process.exit(0);
