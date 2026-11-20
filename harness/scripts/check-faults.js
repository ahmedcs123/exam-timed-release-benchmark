// Pass/fail for the scripted failure/security tests (design Section 8) from the session records in
// results/faults/. A test passes for an arm only at 10/10 valid repetitions. Runs discarded by the scheduler
// (setup overran T0, harness errors) are not counted as repetitions; they are listed in schedule-log.jsonl.
// Run from the repo root:  node harness/scripts/check-faults.js [--reps 10]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const DIR = join(process.cwd(), argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : join('results', 'faults'));
const REQUIRED = Number(argv.includes('--reps') ? argv[argv.indexOf('--reps') + 1] : 10);

const common = (r) => r.summary.earlyCount === 0 && !r.summary.setupOverran;
const allGotKey = (r) => r.summary.okCentres === r.config.m && r.summary.decryptOracleOk === true;
// A fault submission counts as rejected only if it was not accepted and the rejection came from the system:
// B - the coordinator's HTTP status (422 commitment check, 425 before T0);
// A - the transaction was mined and reverted (status 0) and no share was stored for that index.
const rejectedB = (f, status) => f && f.accepted === false && f.status === status;
const rejectedA = (f) => f && f.accepted === false && f.mined === true && f.receiptStatus === 0 && f.storedForIndexAfter === 0;

const CRITERIA = {
  F1: (r) => [r.config.present.length === r.config.n - 2, allGotKey(r)],
  F2: (r) => [r.config.present.length === r.config.k - 1, // n - k + 1 absent = k - 1 present
    r.summary.okCentres === 0, r.summary.alert === 'insufficient shares'],
  F3: (r) => [r.fault?.type === 'corrupt-share', r.config.arm === 'B' ? rejectedB(r.fault, 422) : rejectedA(r.fault), allGotKey(r)],
  // F6: every censored centre still gets the correct key within 60 s of T0 (the others too).
  F6: (r) => [r.config.censored?.length === 5,
    r.config.censored.every((c) => { const x = r.centres.find((y) => y.centreId === c); return x?.ok === true && x.latencyMs <= 60_000; }),
    allGotKey(r)],
  // F7: the replica was really killed at T0 (within 1 s after it) and the release still completed for every centre.
  // Kill command issued within 1 s after T0 and confirmed by Docker (docker kill itself can take ~0.7 s to return).
  F7: (r, res) => [res?.kill?.ok === true, res.kill.startedAtMs >= r.t0Ms && res.kill.startedAtMs - r.t0Ms <= 1000, allGotKey(r)],
  // G1: one admin's attempt to change the trustee set after setup is refused by code, the set is unchanged and the
  // release still completes with the original trustees.
  G1: (r) => [r.fault?.type === 'change-trustees', r.fault.accepted === false, r.fault.trusteesUnchanged === true,
    r.config.arm === 'A' ? r.fault.mined === true && r.fault.receiptStatus === 0 : true, allGotKey(r)],
  // F8: the independent auditor detects each tampering with the record (share edited, submission time moved, entry
  // deleted); in A the contract must also refuse the operator's edit/delete transactions. The release itself happened
  // before the tampering, so every centre must have the key.
  F8: (r) => [r.fault?.type === 'tamper-record', r.fault.detected?.shareEdit === true, r.fault.detected?.timeEdit === true,
    r.fault.detected?.deletion === true, r.config.arm === 'A' ? r.fault.contractRefusedWrites === true : true, allGotKey(r)],
  // F5: with one clock 30 s ahead (A: one validator; B: the coordinator host) and trustees submitting as early as
  // they are allowed, no centre may obtain the key before T0 (tolerance 0 ms, fixed before data), and the skew must
  // have been in effect (A: besu4's own log timestamps; B: the coordinator's configuration).
  F5: (r, res) => [r.config.trusteeMode === 'eager', res?.skewCheck?.ok === true, r.summary.earlyCount === 0],
  F4: (r) => [r.fault?.type === 'early-submit', r.config.arm === 'B' ? rejectedB(r.fault, 425) : rejectedA(r.fault),
    r.config.arm === 'A' ? r.fault?.blockTimestamp != null && r.fault.blockTimestamp * 1000 < r.t0Ms : r.fault?.sentAtMs < r.t0Ms,
    allGotKey(r)],
};

const rows = {};
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json') && !x.endsWith('.resources.json') && x !== 'fault-verdicts.json')) {
  const r = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  const id = r.config.testId;
  if (!CRITERIA[id] || r.summary.setupOverran) continue;
  let res = null; try { res = JSON.parse(readFileSync(join(DIR, f.replace(/\.json$/, '.resources.json')), 'utf8')); } catch { /* not needed for F1-F6 */ }
  const checks = [...CRITERIA[id](r, res), common(r)];
  const key = `${id} ${r.config.arm}`;
  (rows[key] ??= { test: id, arm: r.config.arm, valid: 0, passed: 0, failedRuns: [] }).valid++;
  if (checks.every(Boolean)) rows[key].passed++; else rows[key].failedRuns.push({ run: r.config.runId, checks });
}
const out = Object.values(rows).sort((a, b) => (a.test + a.arm).localeCompare(b.test + b.arm))
  .map((x) => ({ ...x, verdict: x.valid >= REQUIRED && x.passed === x.valid ? 'PASS' : x.valid < REQUIRED ? `INCOMPLETE (${x.valid}/${REQUIRED})` : 'FAIL' }));
for (const x of out) console.log(`${x.test}  arm ${x.arm}  ${x.passed}/${x.valid}  ${x.verdict}${x.failedRuns.length ? '  failed: ' + x.failedRuns.map((f) => f.run).join(', ') : ''}`);
writeFileSync(join(DIR, 'fault-verdicts.json'), JSON.stringify({ date: new Date().toISOString(), required: REQUIRED, results: out }, null, 2));
