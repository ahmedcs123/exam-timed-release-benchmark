// Arm A channel: trustee submission (signed by the trustee's account) and the centre's key fetcher,
// which reads shares straight from the chain on any of the nodes (no coordinator to censor it).
import { combineShares, verifyShareCommitment } from '../../shared/src/index.js';
import { artifact, contractAt, makeProvider, TX } from './chain.js';
import { Interface } from 'ethers';

const iface = new Interface(artifact.abi);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function revertName(err) {
  const data = err?.revert?.name ? null : (err?.data || err?.info?.error?.data || err?.error?.data);
  if (err?.revert?.name) return err.revert.name;
  try { return data ? iface.parseError(data)?.name : null; } catch { return null; }
}

// One submission. Returns { ok, reason, gasUsed, blockNumber }.
export async function submitShare(address, trusteeWallet, examId, index, share) {
  const c = contractAt(address, trusteeWallet);
  try {
    const tx = await c.submitShare(examId, index, share, TX);
    const receipt = await tx.wait();
    return { ok: true, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
  } catch (err) {
    return { ok: false, reason: revertName(err) || err.shortMessage || String(err.message) };
  }
}

// Trustee behaviour at release: retry while the latest block is still before T0 (block time is in seconds).
export async function submitWhenAllowed(address, trusteeWallet, examId, index, share, { retryMs = 500, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0, r;
  do {
    attempts++;
    r = await submitShare(address, trusteeWallet, examId, index, share);
    if (r.ok || r.reason !== 'TooEarly') break;
    await sleep(retryMs);
  } while (Date.now() < deadline);
  return { ...r, attempts };
}

// The centre checks every share against its setup commitment, then rebuilds the key from k shares.
// rpcUrls: tried in order, so a dead or refusing node does not stop the centre (F6/F7 for Arm A).
export function shareFetcher(rpcUrls, address, examId, meta) {
  const readers = rpcUrls.map((u) => contractAt(address, makeProvider(u)));
  return async () => {
    let lastErr;
    for (const c of readers) {
      try {
        const [idx, shares] = await c.getShares(examId);
        const valid = new Map();
        idx.forEach((i, j) => {
          const index = Number(i);
          const share = Buffer.from(shares[j].slice(2), 'hex');
          if (!valid.has(index) && verifyShareCommitment(examId, index, share, meta.commitments[index])) valid.set(index, share);
        });
        if (valid.size < meta.k) return null;
        return combineShares([...valid.values()].slice(0, meta.k));
      } catch (err) { lastErr = err; }
    }
    throw lastErr;
  };
}
