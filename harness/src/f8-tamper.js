// F8 tampering tools for Arm A (design Section 8).
//   tryContractWrites: the operator's only write path is the contract; it tries to edit and to delete a share.
//   startLyingNode: one validator's operator makes its node lie. An HTTP JSON-RPC endpoint that forwards to one real
//   node and rewrites what it returns about one exam: share `editShareIndex` gets one byte flipped, the event time of
//   `editTimeIndex` is moved by `timeShiftS`, and `dropIndex` is removed from getShares and from the event logs.
import http from 'node:http';
import { createRequire } from 'node:module';

const ethers = () => createRequire(new URL('../../arm-a-ledger/package.json', import.meta.url))('ethers');

export async function tryContractWrites({ wallet, address, examId, tx }) {
  const { Interface } = ethers();
  const out = [];
  for (const [sig, args] of [['function editShare(string,uint8,bytes)', [examId, 0, '0x00']], ['function deleteShare(string,uint8)', [examId, 2]]]) {
    const fi = new Interface([sig]);
    let rc = null, reason = null;
    try { rc = await (await wallet.sendTransaction({ to: address, data: fi.encodeFunctionData(fi.fragments[0], args), ...tx, gasLimit: 200_000n })).wait(); }
    catch (e) { rc = e.receipt ?? null; reason = e.code || e.shortMessage || String(e.message); }
    out.push({ call: sig, mined: !!rc, receiptStatus: rc?.status ?? null, reason });
  }
  return out;
}

export async function startLyingNode({ target, abi, examId, address, editShareIndex, editTimeIndex, dropIndex, timeShiftS = 2 }) {
  const { Interface, AbiCoder, keccak256, toUtf8Bytes } = ethers();
  const iface = new Interface(abi);
  const coder = AbiCoder.defaultAbiCoder();
  const sel = iface.getFunction('getShares').selector;
  const topic = iface.getEvent('ShareSubmitted').topicHash;
  const examKey = keccak256(toUtf8Bytes(examId)).toLowerCase();
  const flip = (hex) => hex.slice(0, -2) + (parseInt(hex.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
  const isOurCall = (q) => q.method === 'eth_call' && q.params?.[0]?.to?.toLowerCase() === address.toLowerCase()
    && q.params[0].data?.startsWith(sel) && iface.decodeFunctionData('getShares', q.params[0].data)[0] === examId;
  const ourLog = (l) => l.topics?.[0] === topic && l.topics?.[1]?.toLowerCase() === examKey;
  const rewrite = (q, result) => {
    if (result == null) return result;
    if (isOurCall(q)) {
      const r = iface.decodeFunctionResult('getShares', result);
      const idx = [], shares = [];
      [...r.idx].forEach((i, j) => {
        const n = Number(i);
        if (n === dropIndex) return;
        idx.push(n); shares.push(n === editShareIndex ? flip(r.shares[j]) : r.shares[j]);
      });
      return iface.encodeFunctionResult('getShares', [idx, shares]);
    }
    if (q.method === 'eth_getLogs' && Array.isArray(result)) {
      return result.filter((l) => !(ourLog(l) && Number(BigInt(l.topics[2])) === dropIndex)).map((l) => {
        if (!(ourLog(l) && Number(BigInt(l.topics[2])) === editTimeIndex)) return l;
        const [trustee, t] = coder.decode(['address', 'uint64'], l.data);
        return { ...l, data: coder.encode(['address', 'uint64'], [trustee, t + BigInt(timeShiftS)]) };
      });
    }
    return result;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const q = JSON.parse(body);
        const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
        const a = await r.json();
        const fix = (qq, aa) => (aa && 'result' in aa ? { ...aa, result: rewrite(qq, aa.result) } : aa);
        const out = Array.isArray(q) ? a.map((aa) => fix(q.find((qq) => qq.id === aa.id) || {}, aa)) : fix(q, a);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
      } catch (err) { res.writeHead(502); res.end(JSON.stringify({ error: String(err.message) })); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
