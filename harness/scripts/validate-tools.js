// Step 6b - validation of the measurement tools before the pilot (design Section 7):
//   CPU sampler:    a container burns exactly 1 core for 10 s -> measured CPU-s must be 10 +/- 5 %
//   Memory sampler: a container allocates 500 MiB -> measured increase must be 500 MiB +/- 5 %
//   Clock:          request/response between two containers -> |offset| must stay below 10 ms
// Run from the repo root on the host:  node harness/scripts/validate-tools.js
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startSampler } from '../src/docker-stats.js';

const IMAGE = 'etr-node:dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const dockerQuiet = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const report = { date: new Date().toISOString(), image: IMAGE, tests: {} };

// 1. CPU: idle 2 s, burn 10 s on one core, idle 4 s (container capped at 1 CPU)
{
  const name = 'etr-cal-cpu';
  dockerQuiet('rm', '-f', name);
  docker('run', '-d', '--name', name, '--cpus', '1', IMAGE, 'node', '-e',
    'setTimeout(()=>{const e=Date.now()+10000;while(Date.now()<e){} setTimeout(()=>{},4000)},2000)');
  const s = startSampler([name], 500);
  await sleep(15000);
  const r = (await s.stop())[name];
  dockerQuiet('rm', '-f', name);
  const errPct = r.cpuSeconds == null ? null : ((r.cpuSeconds - 10) / 10) * 100;
  report.tests.cpu = { expectedCpuSeconds: 10, measuredCpuSeconds: r.cpuSeconds, errorPct: errPct,
    pass: errPct != null && Math.abs(errPct) <= 5, samplerIntervalMeanMs: r.intervalMeanMs, samplerIntervalMaxMs: r.intervalMaxMs, samplerErrors: r.errors };
}

// 2. Memory: idle 3 s (baseline), allocate and touch 500 MiB, hold 5 s
{
  const name = 'etr-cal-mem';
  dockerQuiet('rm', '-f', name);
  docker('run', '-d', '--name', name, IMAGE, 'node', '-e',
    'setTimeout(()=>{globalThis.b=Buffer.alloc(500*1024*1024,1);setTimeout(()=>{},5000)},3000)');
  const s = startSampler([name], 500);
  const t0 = Date.now();
  await sleep(8500);
  await s.stop();
  dockerQuiet('rm', '-f', name);
  const ok = s.samples[name].filter((x) => x.memBytes != null);
  const base = ok.filter((x) => x.tMs - t0 < 2500).map((x) => x.memBytes).sort((a, b) => a - b);
  const baseline = base.length ? base[Math.floor(base.length / 2)] : null;
  const peak = ok.length ? Math.max(...ok.map((x) => x.memBytes)) : null;
  const deltaMiB = baseline == null ? null : (peak - baseline) / 2 ** 20;
  const errPct = deltaMiB == null ? null : ((deltaMiB - 500) / 500) * 100;
  report.tests.memory = { expectedMiB: 500, baselineMiB: baseline / 2 ** 20, peakMiB: peak / 2 ** 20, measuredDeltaMiB: deltaMiB, errorPct: errPct,
    pass: errPct != null && Math.abs(errPct) <= 5 };
}

// 3. Clock: 50 request/response pairs between two containers on one Docker network
{
  dockerQuiet('rm', '-f', 'etr-cal-srv');
  dockerQuiet('network', 'create', 'etr-cal-net');
  docker('run', '-d', '--name', 'etr-cal-srv', '--network', 'etr-cal-net', IMAGE, 'node', '-e',
    'require("http").createServer((q,s)=>s.end(String(Date.now()))).listen(9000)');
  const out = docker('run', '--rm', '--network', 'etr-cal-net', IMAGE, 'node', '-e', `(async()=>{
    const url='http://etr-cal-srv:9000'; let ready=false;
    for(let i=0;i<50&&!ready;i++){try{await fetch(url);ready=true;}catch{await new Promise(r=>setTimeout(r,200));}}
    const off=[],rtt=[];
    for(let i=0;i<50;i++){const t1=Date.now();const ts=Number(await (await fetch(url)).text());const t2=Date.now();off.push(ts-(t1+t2)/2);rtt.push(t2-t1);}
    console.log(JSON.stringify({n:off.length,maxAbsOffsetMs:Math.max(...off.map(Math.abs)),meanRttMs:rtt.reduce((a,b)=>a+b,0)/rtt.length,maxRttMs:Math.max(...rtt)}));
  })()`);
  dockerQuiet('rm', '-f', 'etr-cal-srv');
  dockerQuiet('network', 'rm', 'etr-cal-net');
  const c = JSON.parse(out.split('\n').at(-1));
  report.tests.clock = { ...c, thresholdMs: 10, pass: c.maxAbsOffsetMs < 10 };
}

report.allPass = Object.values(report.tests).every((t) => t.pass);
mkdirSync('results/validation', { recursive: true });
const file = `results/validation/tool-validation-${report.date.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
console.table(Object.fromEntries(Object.entries(report.tests).map(([k, v]) => [k, {
  pass: v.pass, measured: v.measuredCpuSeconds ?? v.measuredDeltaMiB ?? v.maxAbsOffsetMs, errorPct: v.errorPct ?? null,
}])));
console.log(`${report.allPass ? 'ALL TOOL CHECKS PASS' : 'SOME TOOL CHECKS FAILED'} -> ${file}`);
process.exit(report.allPass ? 0 : 1);
