// Exam encryption, identical in all arms: AES-256-GCM.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const KEY_BYTES = 32;
const IV_BYTES = 12;

// Exam key derived from the run seed (HKDF-SHA256), so runs are reproducible.
// Only for synthetic experiments: a real deployment would use a random key.
export function deriveExamKey(seed) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(`run-seed:${seed}`), Buffer.alloc(0), Buffer.from('exam-key'), KEY_BYTES));
}

export function encryptExam(plain, key, iv = randomBytes(IV_BYTES)) {
  if (key.length !== KEY_BYTES) throw new Error('key must be 32 bytes');
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), ciphertext };
}

// Throws if the key is wrong or the ciphertext was changed.
export function decryptExam({ iv, tag, ciphertext }, key) {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}
