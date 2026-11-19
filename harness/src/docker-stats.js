// Resource sampler (design Section 7): reads the Docker Engine API from the host every intervalMs.
// CPU-seconds = difference of the cumulative cgroup CPU counter (cpu_stats.cpu_usage.total_usage, ns)
// between the first and last sample. Memory = usage minus inactive_file (what `docker stats` shows);
// the peak is the maximum over the samples.
import http from 'node:http';

const SOCKET = process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function engineGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error(`Docker API ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Docker API timeout')));
    req.end();
  });
}

export async function readStats(name) {
  const s = await engineGet(`/containers/${encodeURIComponent(name)}/stats?stream=false&one-shot=true`);
  const cpuNs = s.cpu_stats?.cpu_usage?.total_usage ?? null;
  const usage = s.memory_stats?.usage ?? null;
  const inactive = s.memory_stats?.stats?.inactive_file ?? 0;
  return { tMs: Date.now(), cpuNs, memBytes: usage == null ? null : usage - inactive };
}

export function startSampler(names, intervalMs = 1000) {
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      await Promise.all(names.map(async (n) => {
        try { samples[n].push(await readStats(n)); } catch (e) { samples[n].push({ tMs: Date.now(), error: String(e.message) }); }
      }));
      await sleep(Math.max(0, intervalMs - (Date.now() - started)));
    }
  })();
  return {
    samples,
    async stop() { stopped = true; await loop; return summarize(samples); },
  };
}

export function summarize(samples) {
  const out = {};
  for (const [name, arr] of Object.entries(samples)) {
    const ok = arr.filter((s) => s.cpuNs != null);
    const gaps = ok.slice(1).map((s, i) => s.tMs - ok[i].tMs);
    out[name] = {
      samples: arr.length,
      errors: arr.length - ok.length,
      cpuSeconds: ok.length >= 2 ? (ok.at(-1).cpuNs - ok[0].cpuNs) / 1e9 : null,
      memMaxBytes: ok.length ? Math.max(...ok.map((s) => s.memBytes ?? 0)) : null,
      intervalMeanMs: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
      intervalMaxMs: gaps.length ? Math.max(...gaps) : null,
    };
  }
  return out;
}
