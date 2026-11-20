// Independent auditor for F8 (design Section 8). It holds only what an outside auditor would hold: the setup
// publication (exam id, T0, k, n, commitments, trustee public keys or addresses) and read access to the system's
// public interfaces. It never sees the harness's own copy of the shares or of the record.
import { createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { verifyShareCommitment, verifyShareSignature } from '../../shared/src/index.js';

// Arm B: reads the record through the coordinator's public API and checks every entry on its own.
// A missing index is not evidence of deletion (trustees may be absent), so it is reported but not flagged.
export async function auditB({ endpoint, examId, setup, now = Date.now }) {
  const r = await fetch(`${endpoint}/exams/${examId}/shares`, { headers: { 'x-centre-id': 'auditor' } });
  const { shares = [] } = r.ok ? await r.json() : {};
  const pubs = setup.trusteePublicKeys.map((p) => createPublicKey(p));
  const entries = shares.map((s) => {
    const problems = [];
    const share = Buffer.from(s.shareHex, 'hex');
    if (!(Number.isInteger(s.index) && s.index >= 0 && s.index < setup.n)) problems.push('bad index');
    else {
      if (!verifyShareCommitment(examId, s.index, share, setup.commitments[s.index])) problems.push('commitment mismatch');
      if (!verifyShareSignature(pubs[s.index], examId, s.index, share, Buffer.from(s.sigHex, 'hex'))) problems.push('bad signature');
    }
    if (!(s.receivedAtMs >= setup.t0Ms)) problems.push('recorded before T0');
    if (s.receivedAtMs > now()) problems.push('recorded in the future');
    return { index: s.index, receivedAtMs: s.receivedAtMs, problems };
  });
  const present = new Set(entries.map((e) => e.index));
  return {
    arm: 'B', httpStatus: r.status, entries,
    missingIndexes: Array.from({ length: setup.n }, (_, i) => i).filter((i) => !present.has(i)),
    flagged: entries.filter((e) => e.problems.length).map((e) => ({ index: e.index, problems: e.problems })),
  };
}

// Arm A: reads the record (getShares + ShareSubmitted events) from every validator endpoint at one common block
// height and compares them. A value backed by a majority of endpoints is taken as the record (BFT assumption:
// at most 1 of 4 validators faulty); every endpoint that differs is reported with the kind of difference.
export async function auditA({ urls, address, examId, setup, abi, timeoutMs = 5000 }) {
  const { Interface, keccak256, toUtf8Bytes } = createRequire(new URL('../../arm-a-ledger/package.json', import.meta.url))('ethers');
  const iface = new Interface(abi);
  const rpc = async (url, method, params) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const heights = await Promise.all(urls.map(async (u) => { try { return parseInt(await rpc(u, 'eth_blockNumber', []), 16); } catch { return null; } }));
  const ok = heights.filter((h) => h != null);
  const tag = `0x${Math.min(...ok).toString(16)}`;
  const topic = iface.getEvent('ShareSubmitted').topicHash;
  const examKey = keccak256(toUtf8Bytes(examId));
  const views = await Promise.all(urls.map(async (u, endpoint) => {
    try {
      const res = iface.decodeFunctionResult('getShares', await rpc(u, 'eth_call', [{ to: address, data: iface.encodeFunctionData('getShares', [examId]) }, tag]));
      const logs = await rpc(u, 'eth_getLogs', [{ address, fromBlock: '0x0', toBlock: tag, topics: [topic, examKey] }]);
      const rec = {};
      [...res.idx].forEach((i, j) => { rec[Number(i)] = { share: res.shares[j].toLowerCase() }; });
      for (const l of logs) {
        const ev = iface.parseLog(l);
        const i = Number(ev.args.index);
        rec[i] = { ...(rec[i] || {}), trustee: ev.args.trustee, blockTime: Number(ev.args.blockTime), blockHash: l.blockHash };
      }
      return { endpoint, ok: true, rec };
    } catch (err) { return { endpoint, ok: false, error: String(err.message) }; }
  }));
  const good = views.filter((v) => v.ok);
  const indexes = [...new Set(good.flatMap((v) => Object.keys(v.rec).map(Number)))].sort((a, b) => a - b);
  const majority = {}, deviations = [];
  const KIND = { share: 'share edit', blockTime: 'time edit', trustee: 'trustee edit', blockHash: 'block edit' };
  for (const i of indexes) {
    const entryKey = (v) => (v.rec[i] ? 'present' : 'missing');
    const counts = {};
    for (const v of good) counts[entryKey(v)] = (counts[entryKey(v)] || 0) + 1;
    if ((counts.present || 0) * 2 > good.length) {
      majority[i] = {};
      for (const f of Object.keys(KIND)) {
        const c = {};
        for (const v of good) if (v.rec[i]) c[String(v.rec[i][f])] = (c[String(v.rec[i][f])] || 0) + 1;
        const [val, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0] || [];
        if (n * 2 > good.length) majority[i][f] = val;
      }
    }
    for (const v of good) {
      if (majority[i] && !v.rec[i]) deviations.push({ endpoint: v.endpoint, index: i, kind: 'deletion' });
      else if (!majority[i] && v.rec[i]) deviations.push({ endpoint: v.endpoint, index: i, kind: 'insertion' });
      else if (majority[i]) for (const f of Object.keys(KIND)) if (majority[i][f] !== undefined && String(v.rec[i][f]) !== majority[i][f]) deviations.push({ endpoint: v.endpoint, index: i, kind: KIND[f] });
    }
  }
  const majorityChecks = Object.entries(majority).map(([i, m]) => {
    const problems = [];
    const index = Number(i);
    if (!m.share || !verifyShareCommitment(examId, index, Buffer.from(m.share.slice(2), 'hex'), setup.commitments[index])) problems.push('commitment mismatch');
    if (!m.trustee || m.trustee.toLowerCase() !== setup.trustees[index].toLowerCase()) problems.push('not the registered trustee');
    if (!(Number(m.blockTime) * 1000 >= Math.ceil(setup.t0Ms / 1000) * 1000)) problems.push('recorded before T0');
    return { index, problems };
  });
  return { arm: 'A', heightTag: tag, endpoints: views.map((v) => ({ endpoint: v.endpoint, ok: v.ok, error: v.error })), deviations, majorityChecks };
}
