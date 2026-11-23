"""Exploratory network-delay cell NET50 (added after the main runs, docs/DEVIATIONS.md 2026-11-23). Descriptive only.

Reads results/exploratory/exploratory-NET50-b<NNN>-<A|B>.resources.json (written by run-schedule.js) and, for
comparison, blocks 1-10 of the primary cell P from results/analysis/runs.csv (same seeds 5001-5010, no delay).
Writes results/exploratory/net50-summary.json and net50-summary.md.
Usage (repo root): python analysis/analyze_netdelay.py
Statistics as for the sensitivity cells: median paired difference with the distribution-free order-statistic CI
(10 pairs: 2nd and 9th ordered differences, coverage 97.85 %); no p-values.
"""
import csv, glob, json, os, re
from math import comb

ROOT = os.getcwd()
EXP = os.path.join(ROOT, 'results', 'exploratory')
if not os.path.exists(os.path.join(ROOT, 'Dockerfile.node')):
    raise SystemExit('Run from the repo root')


def median(xs):
    a = sorted(xs); n = len(a)
    return None if n == 0 else (a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2)


def exact_ci(xs):
    a = sorted(xs); n = len(a); best = None
    for j in range(1, n // 2 + 1):
        cov = 1 - 2 * sum(comb(n, i) for i in range(j)) / 2 ** n
        if cov >= 0.95:
            best = (a[j - 1], a[n - j], cov, j)
    return best


runs = {}
for f in sorted(glob.glob(os.path.join(EXP, 'exploratory-NET50-b*-*.resources.json'))):
    rec = json.load(open(f, encoding='utf-8'))
    m = re.search(r'-b(\d{3})-([AB])\.resources\.json$', f)
    s = (rec.get('session') or {}).get('summary') or {}
    kept = bool(rec.get('session', {}).get('ok')) and bool(s) and not s.get('setupOverran')
    runs[(int(m.group(1)), m.group(2))] = {
        'kept': kept, 'netDelayOk': (rec.get('netDelay') or {}).get('ok'), 'L50': s.get('L50'), 'L95': s.get('L95'),
        'Lmax': s.get('Lmax'), 'earlyCount': s.get('earlyCount'), 'okCentres': s.get('okCentres'),
        'cpu_s': (rec.get('resources') or {}).get('cpuSecondsTotal'), 'readySeconds': rec.get('readySeconds')}

blocks = sorted({b for b, _ in runs})
pairs = [b for b in blocks if runs.get((b, 'A'), {}).get('kept') and runs.get((b, 'B'), {}).get('kept')]
d = [runs[(b, 'A')]['L95'] - runs[(b, 'B')]['L95'] for b in pairs]

p_rows = {}
with open(os.path.join(ROOT, 'results', 'analysis', 'runs.csv'), newline='') as fh:
    for r in csv.DictReader(fh):
        if r['cell'] == 'P' and r['arm'] in 'AB' and int(r['block']) <= 10:
            p_rows[(int(r['block']), r['arm'])] = float(r['L95_ms'])
dP = [p_rows[(b, 'A')] - p_rows[(b, 'B')] for b in range(1, 11) if (b, 'A') in p_rows and (b, 'B') in p_rows]

ci = exact_ci(d) if len(d) >= 6 else None
ciP = exact_ci(dP) if len(dP) >= 6 else None
out = {
    'cell': 'NET50', 'delayMsPerServerEgress': 50, 'pairs': len(pairs), 'runs': len(runs),
    'allDelayChecksOk': all(v['netDelayOk'] for v in runs.values()) if runs else None,
    'earlyReleases': sum((v['earlyCount'] or 0) for v in runs.values()),
    'allCentresOk': all(v['okCentres'] == 50 for v in runs.values() if v['kept']),
    'L95_A_median_ms': median([runs[(b, 'A')]['L95'] for b in pairs]),
    'L95_B_median_ms': median([runs[(b, 'B')]['L95'] for b in pairs]),
    'diff_L95_median_ms': median(d), 'diff_exact_ci_ms': ci[:2] if ci else None, 'diff_exact_coverage': ci[2] if ci else None,
    'P_blocks_1_10_diff_L95_median_ms': median(dP), 'P_blocks_1_10_exact_ci_ms': ciP[:2] if ciP else None,
    'readySeconds_median': {a: median([v['readySeconds'] for (b, x), v in runs.items() if x == a and v['readySeconds']]) for a in 'AB'},
    'cpu_s_median': {a: median([v['cpu_s'] for (b, x), v in runs.items() if x == a and v['kept']]) for a in 'AB'},
    'perPair': [{'block': b, 'L95_A': runs[(b, 'A')]['L95'], 'L95_B': runs[(b, 'B')]['L95']} for b in pairs],
}
json.dump(out, open(os.path.join(EXP, 'net50-summary.json'), 'w'), indent=2)
md = ['# Exploratory cell NET50 (descriptive only)', '',
      f"Pairs: {out['pairs']}. Delay check passed in every run: {out['allDelayChecksOk']}. Early releases: {out['earlyReleases']}. All centres got the key: {out['allCentresOk']}.", '',
      f"Median L95: A {out['L95_A_median_ms']} ms, B {out['L95_B_median_ms']} ms. Median paired difference A - B: {out['diff_L95_median_ms']} ms, exact CI {out['diff_exact_ci_ms']} (coverage {out['diff_exact_coverage']}).", '',
      f"Same blocks of the primary cell without delay: median difference {out['P_blocks_1_10_diff_L95_median_ms']} ms, exact CI {out['P_blocks_1_10_exact_ci_ms']}."]
open(os.path.join(EXP, 'net50-summary.md'), 'w').write('\n'.join(md) + '\n')
print(json.dumps({k: v for k, v in out.items() if k != 'perPair'}, indent=2))
