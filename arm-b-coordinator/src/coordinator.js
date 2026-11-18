// Arm B coordinator: stateless REST service; all state lives in the store (etcd in measured runs).
// Same rules as the Arm A contract: no share before T0, share must match its setup commitment,
// signed by its trustee, first valid share per index wins.
import { createServer } from 'node:http';
import { createPublicKey } from 'node:crypto';
import { verifyShareCommitment, verifyShareSignature } from '../../shared/src/index.js';

const MAX_BODY = 64 * 1024;
const pad = (i) => String(i).padStart(3, '0');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// clockSkewMs: coordinator clock runs ahead (F5). censoredCentres: centre ids it refuses (F6).
export function startCoordinator({ store, port = 0, host = '127.0.0.1', clockSkewMs = 0, now = () => Date.now(), censoredCentres = new Set() }) {
  const clock = () => now() + clockSkewMs;

  async function loadMeta(examId) {
    const raw = await store.get(`exam/${examId}/meta`);
    return raw ? JSON.parse(raw) : null;
  }

  const server = createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      let m;

      // Setup (harness only): PUT /exams/:id  {t0Ms, k, n, commitments[], trusteePublicKeys[] (PEM)}
      if (req.method === 'PUT' && (m = path.match(/^\/exams\/([\w-]+)$/))) {
        const meta = JSON.parse(await readBody(req));
        const { t0Ms, k, n, commitments, trusteePublicKeys } = meta;
        if (!Number.isFinite(t0Ms) || !(k >= 2 && k <= n) || commitments?.length !== n || trusteePublicKeys?.length !== n) {
          return send(400, { error: 'bad exam metadata' });
        }
        const ok = await store.putIfAbsent(`exam/${m[1]}/meta`, JSON.stringify({ t0Ms, k, n, commitments, trusteePublicKeys }));
        return send(ok ? 201 : 409, ok ? { examId: m[1] } : { error: 'exam already registered' });
      }

      // Trustee: POST /exams/:id/shares/:index  {shareHex, sigHex}
      if (req.method === 'POST' && (m = path.match(/^\/exams\/([\w-]+)\/shares\/(\d+)$/))) {
        const [examId, index] = [m[1], Number(m[2])];
        const meta = await loadMeta(examId);
        if (!meta) return send(404, { error: 'unknown exam' });
        if (clock() < meta.t0Ms) return send(425, { error: 'too early' });
        if (index >= meta.n) return send(422, { error: 'bad trustee index' });
        const { shareHex, sigHex } = JSON.parse(await readBody(req));
        const share = Buffer.from(shareHex, 'hex');
        if (!verifyShareCommitment(examId, index, share, meta.commitments[index])) return send(422, { error: 'share does not match commitment' });
        const pub = createPublicKey(meta.trusteePublicKeys[index]);
        if (!verifyShareSignature(pub, examId, index, share, Buffer.from(sigHex, 'hex'))) return send(422, { error: 'bad signature' });
        const ok = await store.putIfAbsent(`exam/${examId}/share/${pad(index)}`, JSON.stringify({ index, shareHex, sigHex, receivedAtMs: now() }));
        return send(ok ? 201 : 409, ok ? { stored: index } : { error: 'share already stored' });
      }

      // Centre: GET /exams/:id/shares  (header x-centre-id)
      if (req.method === 'GET' && (m = path.match(/^\/exams\/([\w-]+)\/shares$/))) {
        if (censoredCentres.has(String(req.headers['x-centre-id']))) return send(403, { error: 'refused' });
        const meta = await loadMeta(m[1]);
        if (!meta) return send(404, { error: 'unknown exam' });
        if (clock() < meta.t0Ms) return send(425, { error: 'too early' });
        const rows = await store.getPrefix(`exam/${m[1]}/share/`);
        return send(200, { shares: rows.map((r) => JSON.parse(r.value)) });
      }

      return send(404, { error: 'not found' });
    } catch (err) {
      return send(400, { error: String(err.message) });
    }
  });

  return new Promise((resolve) => server.listen(port, host, () => resolve({
    url: `http://${host}:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
