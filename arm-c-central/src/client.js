// Arm C channel used by the shared centre client and by the harness.
export async function registerExam(baseUrl, examId, key, releaseAtMs) {
  const r = await fetch(`${baseUrl}/exams/${examId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyHex: key.toString('hex'), releaseAtMs }),
  });
  if (r.status !== 201) throw new Error(`register failed: HTTP ${r.status}`);
}

// Returns the key after T0, null before T0 (HTTP 425).
export function keyFetcher(baseUrl, examId) {
  return async () => {
    const r = await fetch(`${baseUrl}/exams/${examId}/key`);
    if (r.status === 425) { await r.arrayBuffer(); return null; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { keyHex } = await r.json();
    return Buffer.from(keyHex, 'hex');
  };
}
