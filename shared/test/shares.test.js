import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExam, sha256Hex } from '../src/exam.js';
import { deriveExamKey, encryptExam, decryptExam } from '../src/crypto.js';
import {
  splitKey, combineShares, commitShare, verifyShareCommitment,
  generateTrusteeKeys, signShare, verifyShareSignature,
} from '../src/shares.js';

// All k-sized subsets of [0..n-1]
function subsets(n, k, start = 0, acc = []) {
  if (acc.length === k) return [acc];
  const out = [];
  for (let i = start; i < n; i++) out.push(...subsets(n, k, i + 1, [...acc, i]));
  return out;
}

test('(3,5): every 3 of the 5 shares rebuild the key (all 10 subsets)', async () => {
  const key = deriveExamKey(1);
  const shares = await splitKey(key, 5, 3);
  assert.equal(shares.length, 5);
  for (const idx of subsets(5, 3)) {
    assert.deepEqual(await combineShares(idx.map((i) => shares[i])), key, `subset ${idx}`);
  }
});

test('(5,9): any 5 of the 9 shares rebuild the key', async () => {
  const key = deriveExamKey(2);
  const shares = await splitKey(key, 9, 5);
  assert.deepEqual(await combineShares([shares[8], shares[0], shares[4], shares[2], shares[6]]), key);
});

test('k-1 shares do not rebuild the key', async () => {
  const key = deriveExamKey(3);
  const shares = await splitKey(key, 5, 3);
  let wrong;
  try { wrong = await combineShares([shares[0], shares[1]]); } catch { wrong = null; }
  assert.notDeepEqual(wrong, key);
});

test('invalid thresholds are refused', async () => {
  const key = deriveExamKey(4);
  await assert.rejects(splitKey(key, 5, 1));
  await assert.rejects(splitKey(key, 3, 5));
});

test('commitment accepts the right share and rejects a corrupted or swapped one', async () => {
  const shares = await splitKey(deriveExamKey(5), 5, 3);
  const c0 = commitShare('exam-1', 0, shares[0]);
  assert.ok(verifyShareCommitment('exam-1', 0, shares[0], c0));
  const bad = Buffer.from(shares[0]); bad[0] ^= 0x01;
  assert.ok(!verifyShareCommitment('exam-1', 0, bad, c0));          // corrupted (F3)
  assert.ok(!verifyShareCommitment('exam-1', 0, shares[1], c0));    // another trustee's share
  assert.ok(!verifyShareCommitment('exam-2', 0, shares[0], c0));    // another exam
});

test('trustee signature verifies and rejects tampering or the wrong trustee', async () => {
  const shares = await splitKey(deriveExamKey(6), 5, 3);
  const t1 = generateTrusteeKeys(), t2 = generateTrusteeKeys();
  const sig = signShare(t1.privateKey, 'exam-1', 0, shares[0]);
  assert.ok(verifyShareSignature(t1.publicKey, 'exam-1', 0, shares[0], sig));
  assert.ok(!verifyShareSignature(t2.publicKey, 'exam-1', 0, shares[0], sig));
  assert.ok(!verifyShareSignature(t1.publicKey, 'exam-1', 1, shares[0], sig));
});

test('end to end: encrypt exam, split key, rebuild from 3 shares, decrypt', async () => {
  const exam = generateExam(42, 200_000);
  const key = deriveExamKey(42);
  const enc = encryptExam(exam, key);
  const shares = await splitKey(key, 5, 3);
  const rebuilt = await combineShares([shares[4], shares[1], shares[3]]);
  assert.equal(sha256Hex(decryptExam(enc, rebuilt)), sha256Hex(exam));
});
