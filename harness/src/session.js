// One exam session for one arm, run inside the load-generator container (same code for all arms).
// Config from env: ARM (A|B|C), RUN_ID, SEED, M, K, N, POLL_MS, EXAM_SIZE, T0_DELAY_MS, TIMEOUT_MS,
// TRUSTEES_PRESENT (e.g. "0,2,4"), RETRY_MS, OUT_DIR, ENDPOINT (B/C service URL), RPC_URLS (A).
// Optional fault injection (design Section 8): FAULT = corrupt-share (F3) | early-submit (F4) | change-trustees (G1)
// | tamper-record (F8);
// TEST_ID labels
// the record. With FAULT unset the session behaves exactly as before.
// CENSORED (e.g. "0,10,20,30,40", F6): centres refused by the operator they normally use. In A their own node
// refuses them (unreachable endpoint) and they fall back to the other validators; in B the coordinator itself
// refuses them (its CENSOR_CENTRES is set by the scheduler), so here it is only recorded.
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
  fault: env.FAULT || null,
  testId: env.TEST_ID || null,
  trusteeMode: env.TRUSTEE_MODE || 'at-t0', // 'eager' (F5): trustees try from setup on and retry until accepted
  jitterMaxMs: Number(env.JITTER_MAX_MS || 0), // sensitivity cell: each trustee submits at T0 + U(0, JITTER_MAX_MS)
  bgLoadRps: Number(env.BG_LOAD_RPS || 0),     // sensitivity cell: open-loop Poisson unrelated writes per second
  censored: env.CENSORED ? env.CENSORED.split(',').map(Number) : [],
};
if (!['A', 'B', 'C'].includes(cfg.arm)) throw new Error('ARM must be A, B or C');
if (![null, 'corrupt-share', 'early-submit', 'change-trustees', 'tamper-record'].includes(cfg.fault)) throw new Error('FAULT must be corrupt-share, early-submit, change-trustees or tamper-record');
if (!['at-t0', 'eager'].includes(cfg.trusteeMode)) throw new Error('TRUSTEE_MODE must be at-t0 or eager');
if (cfg.fault && cfg.arm === 'C') throw new Error('FAULT applies to trustees, so only to arms A and B');
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
let faultOps = null; // per-arm single submission used only by fault injection
let g1Op = null;     // per-arm attempt by one admin to replace the trustee set (G1)
let tamperOp = null; // per-arm tampering with the submission record + independent audit (F8)
let eagerOnce = null; // per-arm single honest submission attempt for eager trustees (F5)
let submitOne = null; // per-arm honest submission of one trustee at its time (jitter cell)
let bgWrite = null;   // per-arm single unrelated write to the same storage layer (background-load cell)
// Seeded PRNG (mulberry32): jitter values and background-load arrival times depend only on the seed, so the
// A and B runs of a pair get exactly the same ones.
const prng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
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
  // One validly signed submission (no retry): only the commitment check or the T0 check can reject it.
  faultOps = async (i, share) => {
    const sentAtMs = nowMs();
    const status = await b.submitShare(cfg.endpoint, examId, i, share, trustees[i].privateKey);
    return { accepted: status === 201, status, sentAtMs, doneAtMs: nowMs() };
  };
  // G1: one admin with direct access to the store overwrites the exam's trustee keys, bypassing the coordinator's
  // put-if-absent (the only rule against changes in B), then reads the stored record back.
  g1Op = async () => {
    const etcd = env.ETCD_ADMIN_URL || 'http://etcd1:2379';
    const b64 = (x) => Buffer.from(x).toString('base64');
    const metaKey = b64(`exam/${examId}/meta`);
    const read = async () => {
      const r = await fetch(`${etcd}/v3/kv/range`, { method: 'POST', body: JSON.stringify({ key: metaKey }) });
      const j = await r.json();
      return j.kvs?.length ? JSON.parse(Buffer.from(j.kvs[0].value, 'base64').toString('utf8')) : null;
    };
    const before = await read();
    const others = shares.map(() => generateTrusteeKeys());
    const forged = { ...before, trusteePublicKeys: others.map((t) => t.publicKey.export({ type: 'spki', format: 'pem' })) };
    const sentAtMs = nowMs();
    const r = await fetch(`${etcd}/v3/kv/put`, { method: 'POST', body: JSON.stringify({ key: metaKey, value: b64(JSON.stringify(forged)) }) });
    await r.arrayBuffer();
    const after = await read();
    return { method: 'one admin: direct etcd put of the exam record with 5 other trustee keys', accepted: r.ok, httpStatus: r.status,
      trusteesUnchanged: JSON.stringify(before?.trusteePublicKeys) === JSON.stringify(after?.trusteePublicKeys), sentAtMs, doneAtMs: nowMs() };
  };
  // F8: after the release, the operator (direct store access) edits share 0, moves the time of share 1 by +2 s and
  // deletes share 2; then the independent auditor reads the record through the coordinator's public API.
  tamperOp = async () => {
    const etcd = env.ETCD_ADMIN_URL || 'http://etcd1:2379';
    const b64 = (x) => Buffer.from(x).toString('base64');
    const keyOf = (i) => b64(`exam/${examId}/share/${String(i).padStart(3, '0')}`);
    const post = (path, body) => fetch(`${etcd}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
    const get = async (i) => { const j = await post('/v3/kv/range', { key: keyOf(i) }); return j.kvs?.length ? JSON.parse(Buffer.from(j.kvs[0].value, 'base64').toString('utf8')) : null; };
    const put = (i, v) => post('/v3/kv/put', { key: keyOf(i), value: b64(JSON.stringify(v)) });
    const e0 = await get(0); const e1 = await get(1);
    const flip = (hex) => hex.slice(0, -2) + (parseInt(hex.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
    await put(0, { ...e0, shareHex: flip(e0.shareHex) });
    await put(1, { ...e1, receivedAtMs: e1.receivedAtMs + 2000 });
    await post('/v3/kv/deleterange', { key: keyOf(2) });
    const { auditB } = await import('./auditor.js');
    const audit = await auditB({ endpoint: cfg.endpoint, examId, setup: meta });
    const flagged = (i) => audit.flagged.some((f) => f.index === i);
    return { tampering: ['edit share 0', 'move time of share 1 by +2 s', 'delete share 2'], audit,
      detected: { shareEdit: flagged(0), timeEdit: flagged(1), deletion: flagged(2) } };
  };
  // F5: one honest, validly signed attempt; the coordinator's own clock decides whether it is too early.
  eagerOnce = async (i) => { const sentAtMs = nowMs(); const status = await b.submitShare(cfg.endpoint, examId, i, shares[i], trustees[i].privateKey); return { accepted: status === 201, result: status, sentAtMs }; };
  // Jitter cell: the same per-trustee behaviour as the normal submission above, for one trustee.
  submitOne = async (i) => {
    const sentAtMs = nowMs(); let attempts = 0, status;
    do { attempts++; status = await b.submitShare(cfg.endpoint, examId, i, shares[i], trustees[i].privateKey); if (status !== 425) break; await sleep(cfg.retryMs); } while (nowMs() < t0Ms + cfg.timeoutMs);
    return { index: i, ok: status === 201, status, attempts, sentAtMs, doneAtMs: nowMs() };
  };
  // Background-load cell: one unrelated write (64 random bytes under its own key) straight to etcd, round-robin
  // over the 3 members - the storage layer where B keeps the shares.
  const etcdEps = (env.ETCD_LOAD_URLS || 'http://etcd1:2379,http://etcd2:2379,http://etcd3:2379').split(',');
  bgWrite = async (seq) => {
    const b64 = (x) => Buffer.from(x).toString('base64');
    const r = await fetch(`${etcdEps[seq % etcdEps.length]}/v3/kv/put`, { method: 'POST', body: JSON.stringify({ key: b64(`load/${examId}/${seq}`), value: b64(randomUUID().repeat(2).slice(0, 64)) }), signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer(); return r.ok;
  };
} else {
  const chain = await import('../../arm-a-ledger/src/chain.js');
  const a = await import('../../arm-a-ledger/src/client.js');
  const urls = chain.rpcUrls;
  const registrar = chain.wallet(0, urls[0]);
  const { address } = await chain.deploy(registrar);
  const meta = { t0Ms, k: cfg.k, n: cfg.n, commitments };
  const trusteeAccounts = Array.from({ length: cfg.n }, (_, i) => 1 + i);
  await chain.registerExam(address, registrar, examId, meta, trusteeAccounts);
  // Each centre reads from its own node first and fails over to the other validators (Section 5: centres read
  // the chain directly). Until 2026-11-20 only the own node was passed; with all nodes up the behaviour is the same.
  const nodeList = (i) => urls.map((_, j) => urls[(i + j) % urls.length]);
  // F6: the centre's own node refuses it. A closed local port refuses at once; an unresolvable host name made
  // every poll wait on DNS and slowed all centres through Node's shared resolver threads (smoke 2026-11-20).
  const CENSOR_URL = 'http://127.0.0.1:1';
  fetcherFor = (i) => a.shareFetcher(cfg.censored.includes(i) ? [CENSOR_URL, ...nodeList(i).slice(1)] : nodeList(i), address, examId, meta);
  submitAt = () => Promise.all(present.map(async (i) => {
    const sentAtMs = nowMs();
    const r = await a.submitWhenAllowed(address, chain.wallet(1 + i, urls[i % urls.length]), examId, i, shares[i], { retryMs: cfg.retryMs, timeoutMs: cfg.timeoutMs });
    return { index: i, ok: r.ok, reason: r.reason ?? null, gasUsed: r.gasUsed ? Number(r.gasUsed) : null, attempts: r.attempts, sentAtMs, doneAtMs: nowMs() };
  }));
  // One submission with a fixed gas limit, so ethers skips its gas estimate (which would fail in the client)
  // and the transaction is mined: the contract itself must reject it (receipt status 0).
  faultOps = async (i, share) => {
    const w = chain.wallet(1 + i, urls[i % urls.length]);
    const c = chain.contractAt(address, w);
    const sentAtMs = nowMs();
    let rc = null, reason = null;
    try { rc = await (await c.submitShare(examId, i, share, { ...chain.TX, gasLimit: 500_000n })).wait(); }
    catch (e) { rc = e.receipt ?? null; reason = e.code || e.shortMessage || String(e.message); }
    const blockTimestamp = rc ? (await w.provider.getBlock(rc.blockNumber)).timestamp : null;
    const [idx] = await c.getShares(examId);
    return { accepted: rc?.status === 1, mined: !!rc, receiptStatus: rc?.status ?? null, blockNumber: rc?.blockNumber ?? null,
      blockTimestamp, reason, storedForIndexAfter: idx.filter((x) => Number(x) === i).length, sentAtMs, doneAtMs: nowMs() };
  };
  // G1: the registrar (one admin) tries to register the same exam again with five other accounts as trustees
  // (the contract has no other function that touches the trustee set). Fixed gas limit, so the contract decides.
  g1Op = async () => {
    const c = chain.contractAt(address, registrar);
    const key = await c.examKey(examId);
    const readSet = () => Promise.all(Array.from({ length: cfg.n }, (_, i) => c.trusteeOf(key, i)));
    const before = await readSet();
    const others = Array.from({ length: cfg.n }, (_, i) => chain.accounts[1 + cfg.n + i].address);
    const sentAtMs = nowMs();
    let rc = null, reason = null;
    try { rc = await (await c.registerExam(examId, chain.toChainSeconds(t0Ms), cfg.k, others, commitments.map((h) => `0x${h}`), { ...chain.TX, gasLimit: 1_000_000n })).wait(); }
    catch (e) { rc = e.receipt ?? null; reason = e.code || e.shortMessage || String(e.message); }
    const after = await readSet();
    return { method: 'one admin: registerExam again with 5 other trustee accounts', accepted: rc?.status === 1, mined: !!rc,
      receiptStatus: rc?.status ?? null, reason, trusteesUnchanged: before.every((a, i) => a === after[i]), sentAtMs, doneAtMs: nowMs() };
  };
  // F8: after the release, (1) the registrar tries to edit and to delete a share through the contract (its only
  // write path), (2) one validator's operator makes its node lie (edit share 0, move the time of share 1 by +2 s,
  // drop share 2); the independent auditor compares the record on all four endpoints.
  tamperOp = async () => {
    const { tryContractWrites, startLyingNode } = await import('./f8-tamper.js');
    const { auditA } = await import('./auditor.js');
    const attempts = await tryContractWrites({ wallet: registrar, address, examId, tx: chain.TX });
    const liar = await startLyingNode({ target: urls[3], abi: chain.artifact.abi, examId, address, editShareIndex: 0, editTimeIndex: 1, dropIndex: 2 });
    let audit;
    try {
      audit = await auditA({ urls: [urls[0], urls[1], urls[2], liar.url], address, examId, abi: chain.artifact.abi,
        setup: { t0Ms, k: cfg.k, n: cfg.n, commitments, trustees: trusteeAccounts.map((i) => chain.accounts[i].address) } });
    } finally { await liar.close(); }
    const dev = (i, kind) => audit.deviations.some((d) => d.index === i && d.kind === kind);
    return { tampering: ['contract: editShare / deleteShare', 'lying node: edit share 0, move time of share 1 by +2 s, drop share 2'],
      attempts, contractRefusedWrites: attempts.every((a) => a.mined && a.receiptStatus === 0), audit,
      detected: { shareEdit: dev(0, 'share edit'), timeEdit: dev(1, 'time edit'), deletion: dev(2, 'deletion') } };
  };
  // F5: one honest attempt through the normal client (gas estimate on the trustee's own node, then the transaction).
  const eagerWallets = {};
  eagerOnce = async (i) => {
    eagerWallets[i] ??= chain.wallet(1 + i, urls[i % urls.length]);
    const sentAtMs = nowMs();
    const r = await a.submitShare(address, eagerWallets[i], examId, i, shares[i]);
    return { accepted: r.ok === true, result: r.ok ? 'ok' : r.reason, sentAtMs };
  };
  // Jitter cell: the same per-trustee behaviour as the normal submission above, for one trustee.
  submitOne = async (i) => {
    const sentAtMs = nowMs();
    const r = await a.submitWhenAllowed(address, chain.wallet(1 + i, urls[i % urls.length]), examId, i, shares[i], { retryMs: cfg.retryMs, timeoutMs: cfg.timeoutMs });
    return { index: i, ok: r.ok, reason: r.reason ?? null, gasUsed: r.gasUsed ? Number(r.gasUsed) : null, attempts: r.attempts, sentAtMs, doneAtMs: nowMs() };
  };
  // Background-load cell: one unrelated write = a value transfer (a state change on the chain, the storage layer
  // where A keeps the shares). Accounts 1+n .. 4+n (unused as trustees when n = 5), one per node, local nonces;
  // open loop: the transaction is sent without waiting for it to be mined.
  // Created only in the background-load cell (n = 5): with n = 9 accounts 10..13 do not exist (smoke 2026-11-22).
  const loadWallets = cfg.bgLoadRps > 0 ? urls.map((u, j) => chain.wallet(1 + cfg.n + j, u)) : [];
  const loadNonce = {};
  bgWrite = async (seq) => {
    const j = seq % loadWallets.length, w = loadWallets[j];
    loadNonce[j] ??= w.provider.getTransactionCount(w.address, 'pending');
    const nonce = await loadNonce[j]; loadNonce[j] = Promise.resolve(nonce + 1);
    await w.sendTransaction({ to: chain.accounts[0].address, value: 1n, nonce, gasLimit: 21_000n, ...chain.TX });
    return true;
  };
}
marks.setupDone = nowMs();
console.log(JSON.stringify({ event: 'setup-done', t0Ms })); // lets the scheduler act at T0 (F7)
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
// Fault injection (F3/F4). The fault trustee is the first present trustee.
//   early-submit: at T0 - 5 s it submits its (honest) share once; it must be rejected. It then submits normally at T0.
//   corrupt-share: at T0 it first submits its share with one byte flipped (validly signed in B); it must be
//   rejected; then all trustees submit honestly (the honest submissions start after this one attempt).
const faultIdx = present[0];
let faultP = Promise.resolve(null);
if (cfg.fault === 'early-submit') {
  faultP = (async () => { await sleep(Math.max(0, t0Ms - 5000 - nowMs())); return { type: cfg.fault, index: faultIdx, ...(await faultOps(faultIdx, shares[faultIdx])) }; })();
} else if (cfg.fault === 'corrupt-share') {
  const honestSubmit = submitAt;
  submitAt = async () => {
    const bad = Buffer.from(shares[faultIdx]); bad[bad.length - 1] ^= 0x01;
    const r = await faultOps(faultIdx, bad);
    faultP = Promise.resolve({ type: cfg.fault, index: faultIdx, ...r });
    return honestSubmit();
  };
}
// G1: right after setup (before T0) one admin tries to replace the trustee set; the session then runs normally.
if (cfg.fault === 'change-trustees') faultP = (async () => ({ type: cfg.fault, ...(await g1Op()) }))();
// F8: after every centre is done and at least 5 s after T0, the record is tampered with and then audited.
if (cfg.fault === 'tamper-record') faultP = (async () => { await centresP; await sleep(Math.max(0, t0Ms + 5000 - nowMs())); return { type: cfg.fault, ...(await tamperOp()) }; })();
// F5: eager trustees start right after setup and retry every RETRY_MS until accepted or until T0 + TIMEOUT_MS, as
// client software that submits "as soon as allowed" would. Per trustee: number of attempts, attempts sent before T0,
// the distinct results seen, and when the share was first accepted.
if (cfg.trusteeMode === 'eager') {
  const eagerP = Promise.all(present.map(async (i) => {
    let attempts = 0, beforeT0 = 0, acceptedAtMs = null, firstSentAtMs = null, storedByEarlierAttemptAtMs = null;
    const results = {};
    while (nowMs() < t0Ms + cfg.timeoutMs) {
      let at;
      try { at = await eagerOnce(i); } catch (e) { at = { accepted: false, result: String(e.code || e.message).slice(0, 60), sentAtMs: nowMs() }; }
      attempts++; firstSentAtMs ??= at.sentAtMs; if (at.sentAtMs < t0Ms) beforeT0++;
      results[at.result] = (results[at.result] || 0) + 1;
      if (at.accepted) { acceptedAtMs = nowMs(); break; }
      // An earlier attempt was in fact stored although its reply was lost (e.g. RPC timeout while waiting): stop.
      if (at.result === 'AlreadySubmitted' || at.result === 409) { storedByEarlierAttemptAtMs = nowMs(); break; }
      await sleep(cfg.retryMs);
    }
    return { index: i, ok: acceptedAtMs != null || storedByEarlierAttemptAtMs != null, mode: 'eager', attempts, attemptsBeforeT0: beforeT0, results, acceptedAtMs, storedByEarlierAttemptAtMs, sentAtMs: firstSentAtMs, doneAtMs: nowMs() };
  }));
  submitAt = () => eagerP;
}
// Jitter cell: trustee i submits at T0 + U_i, U_i ~ Uniform(0, JITTER_MAX_MS) from the seeded PRNG.
const jitterMs = Object.fromEntries(present.map((i) => [i, Math.floor(prng(cfg.seed * 1000 + i)() * cfg.jitterMaxMs)]));
if (cfg.jitterMaxMs > 0) submitAt = () => Promise.all(present.map(async (i) => { await sleep(jitterMs[i]); return { ...(await submitOne(i)), jitterMs: jitterMs[i] }; }));
// Background-load cell: open-loop Poisson arrivals at BG_LOAD_RPS from setup until every centre is done.
const bg = { rps: cfg.bgLoadRps, sent: 0, ok: 0, errors: 0, firstError: null, startedAtMs: null, stoppedAtMs: null };
let bgStop = false;
const bgP = cfg.bgLoadRps > 0 ? (async () => {
  const rnd = prng(cfg.seed * 7919 + 17), pending = [];
  bg.startedAtMs = nowMs();
  // Arrival times are absolute (start + sum of exponential gaps), so a busy event loop delays writes but does not
  // lower the rate (smoke 2026-11-22: relative sleeps gave 16.5/s instead of 20/s in A).
  let nextAt = nowMs();
  for (let seq = 0; !bgStop; seq++) {
    nextAt += -Math.log(1 - rnd()) * 1000 / cfg.bgLoadRps;
    await sleep(Math.max(0, nextAt - nowMs()));
    if (bgStop) break;
    bg.sent++;
    pending.push(bgWrite(seq).then((ok) => { if (ok) bg.ok++; else bg.errors++; }, (e) => { bg.errors++; bg.firstError ??= String(e.code || e.message).slice(0, 80); }));
  }
  bg.stoppedAtMs = nowMs();
  await Promise.all(pending);
})() : Promise.resolve();
await sleep(Math.max(0, t0Ms - nowMs()));
const trustees = await submitAt();
const centres = await centresP;
bgStop = true; await bgP;
const fault = await faultP;
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
// F2 (design Section 8): "alert raised" = no centre obtained the key by the timeout (T0 + TIMEOUT_MS; 60 s in F2)
// and fewer than k shares were accepted. Defined before any F2 data (docs/DEVIATIONS.md, 2026-11-19).
summary.acceptedShares = cfg.arm === 'C' ? null : trustees.filter((t) => t.ok).length;
summary.alert = cfg.arm !== 'C' && summary.okCentres === 0 && summary.acceptedShares < cfg.k ? 'insufficient shares' : null;
const record = { schema: 1, config: { ...cfg, present }, examId, t0Ms, marks, summary, trustees, centres };
record.fault = fault;
if (cfg.bgLoadRps > 0) record.backgroundLoad = bg;
if (cfg.jitterMaxMs > 0) record.jitterMs = jitterMs;
mkdirSync(cfg.outDir, { recursive: true });
const file = `${cfg.outDir}/${cfg.runId}.json`;
writeFileSync(file, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ file, arm: cfg.arm, ...summary }));
process.exit(0);
