// Shared test scenarios for Arm B, run against MemoryStore (unit) and real etcd (integration).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  generateExam, sha256Hex, deriveExamKey, encryptExam, splitKey, commitShare,
  generateTrusteeKeys, runCentre, nowMs,
} from '../../shared/src/index.js';
import { startCoordinator } from '../src/coordinator.js';
import { registerExam, submitShare, shareFetcher } from '../src/client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function makeSession(seed, k, n, t0Ms) {
  const examId = `e-${randomUUID()}`;
  const exam = generateExam(seed, 200_000);
  const key = deriveExamKey(seed);
  const shares = await splitKey(key, n, k);
  const trustees = shares.map(() => generateTrusteeKeys());
  const meta = {
    t0Ms, k, n,
    commitments: shares.map((s, i) => commitShare(examId, i, s)),
    trusteePublicKeys: trustees.map((t) => t.publicKey.export({ type: 'spki', format: 'pem' })),
  };
  return { examId, shares, trustees, meta, encryptedExam: encryptExam(exam, key), expectedSha256: sha256Hex(exam) };
}

async function withCoordinator(store, opts, fn) {
  const coord = await startCoordinator({ store, ...opts });
  try { return await fn(coord); } finally { await coord.close(); }
}

function centres(m, coord, s, opts = {}) {
  return Promise.all(Array.from({ length: m }, (_, i) => runCentre({
    centreId: i, t0Ms: s.meta.t0Ms, encryptedExam: s.encryptedExam, expectedSha256: s.expectedSha256,
    obtainKey: shareFetcher(coord.url, s.examId, s.meta, i), pollMs: 100, timeoutMs: 4000, ...opts,
  })));
}

async function trusteesSubmitAtT0(coord, s, which) {
  await sleep(Math.max(0, s.meta.t0Ms - nowMs()));
  return Promise.all(which.map((i) => submitShare(coord.url, s.examId, i, s.shares[i], s.trustees[i].privateKey)));
}

export function defineScenarios(test, makeStore) {
  test('F4: a share sent before T0 is refused (425)', async () => {
    const store = await makeStore();
    await withCoordinator(store, {}, async (coord) => {
      const s = await makeSession(1, 3, 5, nowMs() + 60_000);
      await registerExam(coord.url, s.examId, s.meta);
      assert.equal(await submitShare(coord.url, s.examId, 0, s.shares[0], s.trustees[0].privateKey), 425);
    });
  });

  test('F3: corrupted share, wrong signer and duplicate are refused', async () => {
    const store = await makeStore();
    await withCoordinator(store, {}, async (coord) => {
      const s = await makeSession(2, 3, 5, nowMs() - 1000);
      await registerExam(coord.url, s.examId, s.meta);
      const bad = Buffer.from(s.shares[0]); bad[0] ^= 1;
      assert.equal(await submitShare(coord.url, s.examId, 0, bad, s.trustees[0].privateKey), 422);
      assert.equal(await submitShare(coord.url, s.examId, 0, s.shares[0], s.trustees[1].privateKey), 422);
      assert.equal(await submitShare(coord.url, s.examId, 0, s.shares[0], s.trustees[0].privateKey), 201);
      assert.equal(await submitShare(coord.url, s.examId, 0, s.shares[0], s.trustees[0].privateKey), 409);
    });
  });

  test('10 centres get the correct key after T0 when all 5 trustees submit, none early', async () => {
    const store = await makeStore();
    await withCoordinator(store, {}, async (coord) => {
      const s = await makeSession(3, 3, 5, nowMs() + 1500);
      await registerExam(coord.url, s.examId, s.meta);
      const [results, codes] = await Promise.all([centres(10, coord, s), trusteesSubmitAtT0(coord, s, [0, 1, 2, 3, 4])]);
      assert.deepEqual(codes, [201, 201, 201, 201, 201]);
      for (const r of results) {
        assert.ok(r.ok, `centre ${r.centreId} failed`);
        assert.equal(r.early, false);
        assert.ok(r.latencyMs >= 0 && r.latencyMs < 1500, `latency ${r.latencyMs} ms`);
      }
    });
  });

  test('F1: 2 of 5 trustees absent, release still completes', async () => {
    const store = await makeStore();
    await withCoordinator(store, {}, async (coord) => {
      const s = await makeSession(4, 3, 5, nowMs() + 1000);
      await registerExam(coord.url, s.examId, s.meta);
      const [results] = await Promise.all([centres(5, coord, s), trusteesSubmitAtT0(coord, s, [0, 2, 4])]);
      assert.ok(results.every((r) => r.ok && !r.early));
    });
  });

  test('F2: 3 of 5 trustees absent, no centre gets the key', async () => {
    const store = await makeStore();
    await withCoordinator(store, {}, async (coord) => {
      const s = await makeSession(5, 3, 5, nowMs() + 500);
      await registerExam(coord.url, s.examId, s.meta);
      const [results] = await Promise.all([centres(3, coord, s, { timeoutMs: 2000 }), trusteesSubmitAtT0(coord, s, [1, 3])]);
      assert.ok(results.every((r) => !r.ok));
    });
  });

  test('F6 preview: a censoring coordinator blocks chosen centres (expected failure of arm B)', async () => {
    const store = await makeStore();
    await withCoordinator(store, { censoredCentres: new Set(['0', '1']) }, async (coord) => {
      const s = await makeSession(6, 3, 5, nowMs() + 1000);
      await registerExam(coord.url, s.examId, s.meta);
      const [results] = await Promise.all([centres(4, coord, s, { timeoutMs: 2500 }), trusteesSubmitAtT0(coord, s, [0, 1, 2])]);
      assert.deepEqual(results.map((r) => r.ok), [false, false, true, true]);
    });
  });
}
