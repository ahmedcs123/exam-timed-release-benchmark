// Arm A against the running 4-validator Besu QBFT network.
// Start it first: npm run network:up   (then npm run network:check shows NETWORK OK)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  generateExam, sha256Hex, deriveExamKey, encryptExam, splitKey, commitShare, runCentre, nowMs,
} from '../../shared/src/index.js';
import { deploy, wallet, registerExam, network } from '../src/chain.js';
import { submitShare, submitWhenAllowed, shareFetcher } from '../src/client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRUSTEES = [1, 2, 3, 4, 5]; // account indexes of trustees 0..4
const registrar = wallet(0);
const trustee = (i, url = network.rpc[i % 4]) => wallet(TRUSTEES[i], url);

// T0 on a whole second, so every arm uses the same release instant (contract time is in seconds).
const t0In = (ms) => Math.ceil((nowMs() + ms) / 1000) * 1000;

const deployed = await deploy(registrar);
const ADDR = deployed.address;

async function makeSession(seed, k, n, t0Ms) {
  const examId = `e-${randomUUID()}`;
  const exam = generateExam(seed, 200_000);
  const key = deriveExamKey(seed);
  const shares = await splitKey(key, n, k);
  const meta = { t0Ms, k, n, commitments: shares.map((s, i) => commitShare(examId, i, s)) };
  const reg = await registerExam(ADDR, registrar, examId, meta, TRUSTEES.slice(0, n));
  return { examId, shares, meta, regGas: reg.gasUsed, encryptedExam: encryptExam(exam, key), expectedSha256: sha256Hex(exam) };
}

function centres(m, s, opts = {}) {
  return Promise.all(Array.from({ length: m }, (_, i) => runCentre({
    centreId: i, t0Ms: s.meta.t0Ms, encryptedExam: s.encryptedExam, expectedSha256: s.expectedSha256,
    obtainKey: shareFetcher([network.rpc[i % 4]], ADDR, s.examId, s.meta), pollMs: 200, timeoutMs: 15_000, ...opts,
  })));
}

async function trusteesAtT0(s, which) {
  await sleep(Math.max(0, s.meta.t0Ms - nowMs()));
  return Promise.all(which.map((i) => submitWhenAllowed(ADDR, trustee(i), s.examId, i, s.shares[i])));
}

test('contract deployed and exam registration works', async (t) => {
  const s = await makeSession(1, 3, 5, t0In(60_000));
  t.diagnostic(`deploy gas ${deployed.gasUsed}, registerExam gas ${s.regGas}`);
  assert.ok(ADDR.startsWith('0x'));
});

test('F4: a share sent before T0 is refused by the contract (TooEarly)', async () => {
  const s = await makeSession(2, 3, 5, t0In(60_000));
  const r = await submitShare(ADDR, trustee(0), s.examId, 0, s.shares[0]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'TooEarly');
});

test('F3: corrupted share, wrong trustee account and duplicate are refused', async (t) => {
  const s = await makeSession(3, 3, 5, t0In(-10_000));
  const bad = Buffer.from(s.shares[0]); bad[0] ^= 1;
  assert.equal((await submitShare(ADDR, trustee(0), s.examId, 0, bad)).reason, 'BadCommitment');
  assert.equal((await submitShare(ADDR, trustee(1), s.examId, 0, s.shares[0])).reason, 'NotTrustee');
  const ok = await submitShare(ADDR, trustee(0), s.examId, 0, s.shares[0]);
  assert.equal(ok.ok, true);
  t.diagnostic(`submitShare gas ${ok.gasUsed}`);
  assert.equal((await submitShare(ADDR, trustee(0), s.examId, 0, s.shares[0])).reason, 'AlreadySubmitted');
});

test('10 centres (reading from all 4 nodes) get the correct key after T0, none early', async (t) => {
  const s = await makeSession(4, 3, 5, t0In(4000));
  const [results, subs] = await Promise.all([centres(10, s), trusteesAtT0(s, [0, 1, 2, 3, 4])]);
  assert.ok(subs.every((r) => r.ok), JSON.stringify(subs.map((r) => r.reason)));
  for (const r of results) {
    assert.ok(r.ok, `centre ${r.centreId} failed`);
    assert.equal(r.early, false);
  }
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  t.diagnostic(`latency ms min ${lat[0]} max ${lat.at(-1)}; trustee attempts ${subs.map((r) => r.attempts).join(',')}`);
});

test('F1: 2 of 5 trustees absent, release still completes', async () => {
  const s = await makeSession(5, 3, 5, t0In(4000));
  const [results] = await Promise.all([centres(5, s), trusteesAtT0(s, [0, 2, 4])]);
  assert.ok(results.every((r) => r.ok && !r.early));
});

test('F2: 3 of 5 trustees absent, no centre gets the key', async () => {
  const s = await makeSession(6, 3, 5, t0In(3000));
  const [results] = await Promise.all([centres(3, s, { timeoutMs: 8000 }), trusteesAtT0(s, [1, 3])]);
  assert.ok(results.every((r) => !r.ok));
});

test('F6/F7 preview: a centre whose first node is unreachable still gets the key from another node', async () => {
  const s = await makeSession(7, 3, 5, t0In(4000));
  const run = runCentre({
    centreId: 0, t0Ms: s.meta.t0Ms, encryptedExam: s.encryptedExam, expectedSha256: s.expectedSha256,
    obtainKey: shareFetcher(['http://127.0.0.1:1', network.rpc[2]], ADDR, s.examId, s.meta), pollMs: 200, timeoutMs: 15_000,
  });
  const [r] = await Promise.all([run, trusteesAtT0(s, [0, 1, 2])]);
  assert.ok(r.ok && !r.early);
});
