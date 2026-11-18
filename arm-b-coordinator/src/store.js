// Share stores used by the coordinator. Same interface:
//   putIfAbsent(key, value) -> true if written, false if the key already existed
//   get(key) -> value or null;  getPrefix(prefix) -> [{key, value}]
// EtcdStore talks to etcd's v3 HTTP/JSON gateway with plain fetch (no extra dependency)
// and fails over to the next endpoint if one node is down (test F7).

const b64 = (x) => Buffer.from(x).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
function prefixEnd(prefix) {
  const b = Buffer.from(prefix);
  b[b.length - 1] += 1;
  return b;
}

export class EtcdStore {
  constructor(endpoints, { timeoutMs = 2000 } = {}) {
    this.endpoints = endpoints;
    this.timeoutMs = timeoutMs;
  }

  async #call(path, body) {
    let lastErr;
    for (const ep of this.endpoints) {
      try {
        const r = await fetch(`${ep}${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
        if (!r.ok) throw new Error(`etcd ${ep} HTTP ${r.status}: ${await r.text()}`);
        return await r.json();
      } catch (err) { lastErr = err; }
    }
    throw lastErr;
  }

  // Atomic: write only if the key was never created (first valid share wins).
  async putIfAbsent(key, value) {
    const k = b64(key);
    const res = await this.#call('/v3/kv/txn', {
      compare: [{ target: 'CREATE', result: 'EQUAL', key: k, create_revision: '0' }],
      success: [{ requestPut: { key: k, value: b64(value) } }],
    });
    return res.succeeded === true;
  }

  async get(key) {
    const res = await this.#call('/v3/kv/range', { key: b64(key) });
    return res.kvs?.length ? unb64(res.kvs[0].value) : null;
  }

  async getPrefix(prefix) {
    const res = await this.#call('/v3/kv/range', { key: b64(prefix), range_end: b64(prefixEnd(prefix)) });
    return (res.kvs || []).map((kv) => ({ key: unb64(kv.key), value: unb64(kv.value) }));
  }

  async healthy() {
    for (const ep of this.endpoints) {
      try {
        const r = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok && (await r.json()).health === 'true') return true;
      } catch { /* try next */ }
    }
    return false;
  }
}

// In-memory store with the same interface: unit tests only, never in measured runs.
export class MemoryStore {
  #m = new Map();
  async putIfAbsent(key, value) { if (this.#m.has(key)) return false; this.#m.set(key, value); return true; }
  async get(key) { return this.#m.has(key) ? this.#m.get(key) : null; }
  async getPrefix(prefix) {
    return [...this.#m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value }));
  }
  async healthy() { return true; }
}
