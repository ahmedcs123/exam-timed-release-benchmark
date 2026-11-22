// Main run schedule (design Section 6): primary cell + one-factor-at-a-time sensitivity cells. Each cell is one call
// of the run scheduler with fixed settings and its own seeds; every run is a fresh arm, with warm-up, sampler and
// storage measurement. Records go to results/raw/ (the data). Runs whose record already exists are skipped
// (--resume), so the schedule can be spread over several nights by simply running this again.
// Run from the repo root:
//   node harness/scripts/run-main.js                      all cells, continuing where it stopped
//   node harness/scripts/run-main.js --only P,M10         some cells
//   node harness/scripts/run-main.js --smoke              1 block of every cell into results/smoke (not data)
//   node harness/scripts/run-main.js --dry-run            print the schedule only
import { spawnSync } from 'node:child_process';

// Cells fixed before any main-run data (2026-11-22). Primary: M = 50, (k, n) = (3, 5), 500 ms polling, 5 MB exam,
// block period 2 s, no jitter, no background load. Each sensitivity cell changes exactly one factor.
const CELLS = {
  P:        { blocks: 20, arms: 'A,B,C', seed0: 5000, args: [] },                         // primary: 20 pairs + 20 C runs
  M10:      { blocks: 10, arms: 'A,B', seed0: 5100, args: ['--m', '10'] },
  M200:     { blocks: 10, arms: 'A,B', seed0: 5200, args: ['--m', '200'] },
  K5N9:     { blocks: 10, arms: 'A,B', seed0: 5300, args: ['--k', '5', '--n', '9'] },
  JIT30:    { blocks: 10, arms: 'A,B', seed0: 5400, args: ['--jitter-max-ms', '30000'] },
  LOAD20:   { blocks: 10, arms: 'A,B', seed0: 5500, args: ['--bg-rps', '20'] },
  BP1:      { blocks: 10, arms: 'A,B', seed0: 5600, args: ['--block-period', '1'] },  // A only differs; B runs as primary
  BP5:      { blocks: 10, arms: 'A,B', seed0: 5700, args: ['--block-period', '5'] },  // A only differs; B runs as primary
  POLL200:  { blocks: 10, arms: 'A,B', seed0: 5800, args: ['--poll-ms', '200'] },
  POLL1000: { blocks: 10, arms: 'A,B', seed0: 5900, args: ['--poll-ms', '1000'] },
  EX1:      { blocks: 10, arms: 'A,B', seed0: 6000, args: ['--exam-size', '1MB'] },
  EX20:     { blocks: 10, arms: 'A,B', seed0: 6100, args: ['--exam-size', '20MB'] },
};

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const smoke = argv.includes('--smoke');
const only = opt('only', null)?.split(',');
const ids = Object.keys(CELLS).filter((id) => !only || only.includes(id));
if (only && ids.length !== only.length) { console.error(`Unknown cell in --only. Cells: ${Object.keys(CELLS).join(', ')}`); process.exit(1); }

for (const id of ids) {
  const c = CELLS[id];
  const args = ['harness/scripts/run-schedule.js', '--phase', smoke ? 'smoke' : 'raw', '--test', id,
    '--blocks', smoke ? '1' : String(c.blocks), '--arms', c.arms, '--seed0', String(c.seed0), ...c.args,
    ...(smoke ? [] : ['--resume']), ...(argv.includes('--dry-run') ? ['--dry-run'] : [])];
  console.log(`\n=== ${id}: node ${args.join(' ')}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${id}: scheduler exited with status ${r.status}`); process.exit(1); }
}
