// Runs one group of the scripted failure/security tests (design Section 8), 10 repetitions per arm, by calling
// the run scheduler once per test with that test's fixed settings. Each repetition is a fresh arm.
// Run from the repo root:  node harness/scripts/run-faults.js --group 1 [--reps 10] [--arms A,B] [--dry-run]
// Then:                    node harness/scripts/check-faults.js
// Quick check (not data):  node harness/scripts/run-faults.js --group 1 --reps 1 --arms A --phase smoke
//                          node harness/scripts/check-faults.js --dir results/smoke --reps 1
import { spawnSync } from 'node:child_process';

// Test definitions (fixed before any fault data, 2026-11-19). seed0 differs per test so the material differs.
const TESTS = {
  F1: { group: 1, seed0: 3100, args: ['--present', '0,1,2'] },                        // n - k = 2 of 5 trustees absent
  F2: { group: 1, seed0: 3200, args: ['--present', '0,1', '--timeout-ms', '60000'] }, // n - k + 1 = 3 absent; wait to T0 + 60 s
  F3: { group: 1, seed0: 3300, args: ['--fault', 'corrupt-share'] },                 // one corrupted (validly signed) share
  F4: { group: 1, seed0: 3400, args: ['--fault', 'early-submit'] },                  // one submission at T0 - 5 s
  F5: { group: 2, seed0: 3500, args: ['--clock-skew-ms', '30000', '--trustee-mode', 'eager', '--t0-delay-ms', '45000'] }, // one clock +30 s
  F6: { group: 3, seed0: 3600, args: ['--censor', '0,10,20,30,40'] },                // 5 of 50 centres censored
  F7: { group: 3, seed0: 3700, args: ['--kill-at-t0'] },                             // 1 replica killed at T0
  F8: { group: 4, seed0: 3800, args: ['--fault', 'tamper-record'] },                 // operator tampers with the record
  G1: { group: 4, seed0: 3900, args: ['--fault', 'change-trustees', '--timeout-ms', '60000'] }, // one admin changes trustees
};

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const group = Number(opt('group', 1));
const reps = opt('reps', '10');
const arms = opt('arms', 'A,B');
const phase = opt('phase', 'faults'); // 'smoke' for a quick check that is not part of the data
const ids = Object.entries(TESTS).filter(([, t]) => t.group === group).map(([id]) => id);
if (!ids.length) { console.error(`No tests defined for group ${group} yet`); process.exit(1); }

for (const id of ids) {
  const t = TESTS[id];
  const args = ['harness/scripts/run-schedule.js', '--phase', phase, '--test', id, '--blocks', reps, '--arms', arms,
    '--seed0', String(t.seed0), ...t.args, ...(argv.includes('--dry-run') ? ['--dry-run'] : [])];
  console.log(`\n=== ${id}: node ${args.join(' ')}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${id}: scheduler exited with status ${r.status}`); process.exit(1); }
}
