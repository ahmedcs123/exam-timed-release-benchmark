// Arm C: single central key server. Holds the WHOLE key, releases it at T0 by its own clock.
// Reference arm only (design Section 5): never the basis of a claim.
import { createServer } from 'node:http';

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// clockSkewMs simulates a server whose clock runs ahead (test F5).
export function startKeyServer({ port = 0, host = '127.0.0.1', clockSkewMs = 0, now = () => Date.now() } = {}) {
  const exams = new Map();
  const clock = () => now() + clockSkewMs;

  const server = createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const m = new URL(req.url, 'http://localhost').pathname.match(/^\/exams\/([\w-]+)(\/key)?$/);
      // Setup (harness only): PUT /exams/:id  {keyHex, releaseAtMs}
      if (req.method === 'PUT' && m && !m[2]) {
        if (exams.has(m[1])) return send(409, { error: 'exam already registered' });
        const { keyHex, releaseAtMs } = JSON.parse(await readBody(req));
        if (!/^[0-9a-f]{64}$/i.test(keyHex) || !Number.isFinite(releaseAtMs)) return send(400, { error: 'bad exam' });
        exams.set(m[1], { key: Buffer.from(keyHex, 'hex'), releaseAtMs });
        return send(201, { examId: m[1] });
      }
      // Centre: GET /exams/:id/key -> 425 before T0, 200 with the key after T0
      if (req.method === 'GET' && m && m[2]) {
        const e = exams.get(m[1]);
        if (!e) return send(404, { error: 'unknown exam' });
        if (clock() < e.releaseAtMs) return send(425, { error: 'too early' });
        return send(200, { keyHex: e.key.toString('hex') });
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
