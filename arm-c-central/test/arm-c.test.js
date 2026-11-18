import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExam, sha256Hex, deriveExamKey, encryptExam, runCentre, nowMs } from '../../shared/src/index.js';
import { startKeyServer } from '../src/server.js';
import { registerExam, keyFetcher } from '../src/client.js';

async function setupExam(srv, examId, seed, t0Ms) {
  const exam = generateExam(seed, 200_000);
  const key = deriveExamKey(seed);
  await registerExam(srv.url, examId, key, t0Ms);
  return { encryptedExam: encryptExam(exam, key), expectedSha256: sha256Hex(exam) };
}

function runCentres(m, srv, examId, t0Ms, setup, opts = {}) {
  return Promise.all(Array.from({ length: m }, (_, i) => runCentre({
    centreId: i, t0Ms, ...setup, obtainKey: keyFetcher(srv.url, examId), pollMs: 100, timeoutMs: 5000, ...opts,
  })));
}

test('no key before T0 (HTTP 425), unknown exam 404, duplicate registration 409', async () => {
  const srv = await startKeyServer();
  try {
    await setupExam(srv, 'e1', 1, nowMs() + 60_000);
    assert.equal((await fetch(`${srv.url}/exams/e1/key`)).status, 425);
    assert.equal((await fetch(`${srv.url}/exams/nope/key`)).status, 404);
    await assert.rejects(registerExam(srv.url, 'e1', deriveExamKey(1), nowMs()));
  } finally { await srv.close(); }
});

test('10 centres: every centre gets the correct key after T0, none before', async () => {
  const srv = await startKeyServer();
  try {
    const t0Ms = nowMs() + 1500;
    const setup = await setupExam(srv, 'e2', 2, t0Ms);
    const results = await runCentres(10, srv, 'e2', t0Ms, setup);
    for (const r of results) {
      assert.ok(r.ok, `centre ${r.centreId} did not get the key`);
      assert.equal(r.early, false, `centre ${r.centreId} got the key early`);
      assert.ok(r.latencyMs >= 0 && r.latencyMs < 1000, `latency ${r.latencyMs} ms`);
    }
  } finally { await srv.close(); }
});

test('F5 preview: a server clock 5 s ahead releases the key before T0 (expected failure of arm C)', async () => {
  const srv = await startKeyServer({ clockSkewMs: 5000 });
  try {
    const t0Ms = nowMs() + 3000;
    const setup = await setupExam(srv, 'e3', 3, t0Ms);
    const results = await runCentres(5, srv, 'e3', t0Ms, setup);
    assert.ok(results.every((r) => r.ok && r.early), 'expected every centre to get the key early');
  } finally { await srv.close(); }
});
