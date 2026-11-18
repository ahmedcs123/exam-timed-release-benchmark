// Checks the 4 Besu nodes: block height, peers, QBFT validators.
const urls = [18545, 18546, 18547, 18548].map((p) => `http://127.0.0.1:${p}`);
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(3000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
let ok = true;
for (const u of urls) {
  try {
    const [block, peers, validators] = await Promise.all([
      rpc(u, 'eth_blockNumber'), rpc(u, 'net_peerCount'), rpc(u, 'qbft_getValidatorsByBlockNumber', ['latest']),
    ]);
    console.log(`${u}  block=${parseInt(block, 16)}  peers=${parseInt(peers, 16)}  validators=${validators.length}`);
    if (parseInt(peers, 16) < 3 || validators.length !== 4) ok = false;
  } catch (e) { ok = false; console.log(`${u}  DOWN (${e.message})`); }
}
console.log(ok ? 'NETWORK OK' : 'NETWORK NOT READY (wait 30 s and run again)');
process.exit(ok ? 0 : 1);
