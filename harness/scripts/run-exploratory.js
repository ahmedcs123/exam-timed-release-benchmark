// Exploratory cell added after the main runs (2026-11-23, docs/DEVIATIONS.md): network delay.
// NET50: tc netem delay of 50 ms on the egress of every server container (validators; coordinator and etcd members),
// otherwise the primary cell (M = 50, (k, n) = (3, 5), 500 ms polling, 5 MB exam, block period 2 s), 10 pairs A-B,
// the same seeds as blocks 1-10 of the primary cell (seed0 5000). Records go to results/exploratory/ so the
// pre-registered analysis (results/raw, results/analysis) is not changed. Descriptive only.
// Run from the repo root (Docker running, images etr-node:dev and etr-netem:dev built):
//   node harness/scripts/run-exploratory.js            10 pairs, continuing where it stopped
//   node harness/scripts/run-exploratory.js --smoke    1 pair into results/smoke (not data)
//   node harness/scripts/run-exploratory.js --dry-run  print the schedule only
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const smoke = argv.includes('--smoke');
const args = ['harness/scripts/run-schedule.js', '--phase', smoke ? 'smoke' : 'exploratory', '--test', 'NET50',
  '--blocks', smoke ? '1' : '10', '--arms', 'A,B', '--seed0', '5000', '--net-delay-ms', '50',
  ...(smoke ? [] : ['--resume']), ...(argv.includes('--dry-run') ? ['--dry-run'] : [])];
console.log(`node ${args.join(' ')}`);
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
