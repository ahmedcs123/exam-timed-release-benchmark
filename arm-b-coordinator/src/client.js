// Arm B channel: harness setup, trustee submission and the centre's key fetcher.
import { createPublicKey } from 'node:crypto';
import { signShare, verifyShareCommitment, verifyShareSignature, combineShares } from '../../shared/src/index.js';

export async function registerExam(baseUrl, examId, meta) {
  const r = await fetch(`${baseUrl}/exams/${examId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta) });
  if (r.status !== 201) throw new Error(`register failed: HTTP ${r.status}`);
}

// Returns the HTTP status: 201 stored, 425 too early, 409 duplicate, 422 rejected.
export async function submitShare(baseUrl, examId, index, share, privateKey) {
  const sigHex = signShare(privateKey, examId, index, share).toString('hex');
  const r = await fetch(`${baseUrl}/exams/${examId}/shares/${index}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shareHex: share.toString('hex'), sigHex }),
  });
  await r.arrayBuffer();
  return r.status;
}

// The centre re-checks every share itself (commitment + signature), so the coordinator
// cannot slip in a forged share; it rebuilds the key once k valid shares are available.
export function shareFetcher(baseUrl, examId, meta, centreId) {
  const pubs = meta.trusteePublicKeys.map((p) => createPublicKey(p));
  return async () => {
    const r = await fetch(`${baseUrl}/exams/${examId}/shares`, { headers: { 'x-centre-id': String(centreId) } });
    if (r.status === 425) { await r.arrayBuffer(); return null; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { shares } = await r.json();
    const valid = new Map();
    for (const s of shares) {
      const share = Buffer.from(s.shareHex, 'hex');
      if (s.index >= 0 && s.index < meta.n && !valid.has(s.index)
        && verifyShareCommitment(examId, s.index, share, meta.commitments[s.index])
        && verifyShareSignature(pubs[s.index], examId, s.index, share, Buffer.from(s.sigHex, 'hex'))) {
        valid.set(s.index, share);
      }
    }
    if (valid.size < meta.k) return null;
    return combineShares([...valid.values()].slice(0, meta.k));
  };
}
