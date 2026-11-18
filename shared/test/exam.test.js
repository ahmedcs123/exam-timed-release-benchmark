import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExam, parseSize, sha256Hex } from '../src/exam.js';
import { deriveExamKey, encryptExam, decryptExam } from '../src/crypto.js';

test('parseSize understands B, KB and MB', () => {
  assert.equal(parseSize('300'), 300);
  assert.equal(parseSize('1KB'), 1024);
  assert.equal(parseSize('5MB'), 5 * 1024 * 1024);
  assert.throws(() => parseSize('5GB'));
});

test('same seed gives identical exam bytes', () => {
  assert.equal(sha256Hex(generateExam(42, 4096)), sha256Hex(generateExam(42, 4096)));
});

test('different seeds give different exams', () => {
  assert.notEqual(sha256Hex(generateExam(42, 4096)), sha256Hex(generateExam(43, 4096)));
});

test('exam has exactly the requested size', () => {
  assert.equal(generateExam(1, parseSize('1MB')).length, 1024 * 1024);
});

test('encrypt then decrypt returns the original exam', () => {
  const exam = generateExam(7, 100_000);
  const key = deriveExamKey(7);
  assert.equal(sha256Hex(decryptExam(encryptExam(exam, key), key)), sha256Hex(exam));
});

test('key derivation is reproducible and 32 bytes', () => {
  assert.equal(deriveExamKey(7).length, 32);
  assert.deepEqual(deriveExamKey(7), deriveExamKey(7));
  assert.notDeepEqual(deriveExamKey(7), deriveExamKey(8));
});

test('wrong key is rejected', () => {
  const enc = encryptExam(generateExam(7, 1000), deriveExamKey(7));
  assert.throws(() => decryptExam(enc, deriveExamKey(8)));
});

test('tampered ciphertext is rejected', () => {
  const key = deriveExamKey(7);
  const enc = encryptExam(generateExam(7, 1000), key);
  enc.ciphertext[0] ^= 0xff;
  assert.throws(() => decryptExam(enc, key));
});
