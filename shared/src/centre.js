// Exam-centre client, identical in all arms. Only `obtainKey` differs per arm:
// it returns the key (Buffer) when available, or null if it is not released yet.
import { decryptExam } from './crypto.js';
import { sha256Hex } from './exam.js';

// One clock for every process on the host (Date.now, 1 ms resolution).
export const nowMs = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls until the correct key arrives or the timeout passes.
// latencyMs = time the correct key was first obtained minus T0 (Section 7, metric L_i).
export async function runCentre({
  centreId, t0Ms, encryptedExam, expectedSha256, obtainKey,
  pollMs = 500, timeoutMs = 120_000, now = nowMs,
}) {
  const deadline = t0Ms + timeoutMs;
  let polls = 0, errors = 0;
  while (now() < deadline) {
    polls++;
    let key = null;
    try { key = await obtainKey(); } catch { errors++; }
    if (key) {
      const gotAtMs = now();
      let ok = false;
      try { ok = sha256Hex(decryptExam(encryptedExam, key)) === expectedSha256; } catch { ok = false; }
      if (ok) return { centreId, ok: true, gotAtMs, latencyMs: gotAtMs - t0Ms, early: gotAtMs < t0Ms, polls, errors };
      errors++; // wrong key: keep polling
    }
    await sleep(pollMs);
  }
  return { centreId, ok: false, gotAtMs: null, latencyMs: null, early: false, polls, errors };
}
