// Key splitting, share commitments and trustee signatures, identical in all arms.
// Shamir library: shamir-secret-sharing 0.0.4 (Privy; audited by Cure53 and Zellic), pinned exactly.
import { split, combine } from 'shamir-secret-sharing';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

// Split a 32-byte key into n shares; any k of them rebuild it.
export async function splitKey(key, n, k) {
  if (!(k >= 2 && k <= n && n <= 255)) throw new Error(`invalid threshold k=${k}, n=${n}`);
  const shares = await split(new Uint8Array(key), n, k);
  return shares.map((s) => Buffer.from(s));
}

// Rebuild the key from k (or more) shares.
export async function combineShares(shares) {
  return Buffer.from(await combine(shares.map((s) => new Uint8Array(s))));
}

// Commitment registered at setup: SHA-256 over exam id, trustee index and share.
// Used in all arms to reject a corrupted or swapped share (test F3).
export function commitShare(examId, index, share) {
  return createHash('sha256').update(`commit:${examId}:${index}:`).update(share).digest('hex');
}

export function verifyShareCommitment(examId, index, share, commitment) {
  return commitShare(examId, index, share) === commitment;
}

// Trustee signing keys (Ed25519). Arm B checks these signatures; Arm A uses account signatures.
export function generateTrusteeKeys() {
  return generateKeyPairSync('ed25519');
}

function shareMessage(examId, index, share) {
  return Buffer.concat([Buffer.from(`share:${examId}:${index}:`), share]);
}

export function signShare(privateKey, examId, index, share) {
  return sign(null, shareMessage(examId, index, share), privateKey);
}

export function verifyShareSignature(publicKey, examId, index, share, signature) {
  return verify(null, shareMessage(examId, index, share), publicKey, signature);
}
