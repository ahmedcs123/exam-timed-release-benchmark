// Synthetic exam generator (no real exams, no personal data).
// The same seed and size always give the same bytes, so every run can be reproduced.
import { createCipheriv, createHash } from 'node:crypto';

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 * 1024 };

// "5MB" -> 5242880, "1KB" -> 1024, "300" -> 300
export function parseSize(text) {
  const m = String(text).trim().toUpperCase().match(/^(\d+)\s*(B|KB|MB)?$/);
  if (!m) throw new Error(`Invalid size: ${text}`);
  return Number(m[1]) * SIZE_UNITS[m[2] || 'B'];
}

// Deterministic bytes: AES-256-CTR keystream with key = SHA-256("exam-seed:" + seed).
export function generateExam(seed, sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Error('sizeBytes must be a positive integer');
  const key = createHash('sha256').update(`exam-seed:${seed}`).digest();
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16, 0));
  return Buffer.concat([cipher.update(Buffer.alloc(sizeBytes, 0)), cipher.final()]);
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
