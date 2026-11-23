# Claims and evidence

Every number reported in the manuscript, with the file and field that holds it. A number that is not in this table does not go into the paper.

Abbreviations of source files:

| Key | File |
| --- | --- |
| S | `results/analysis/summary.json` (written by `harness/scripts/analyze.js`) |
| E | `results/analysis/effects_A_vs_B.csv` (same script) |
| R | `results/analysis/runs.csv` (one row per measured run) |
| REP | `results/analysis/report.md` (human-readable form of S) |
| FV | `results/faults/fault-verdicts.json` (written by `harness/scripts/check-faults.js`) |
| FR | `results/faults/faults-<test>-b<NNN>-<arm>.json` (raw fault-test runs) |
| RAW | `results/raw/raw-<cell>-b<NNN>-<arm>.json` (raw measured runs) |
| VAL | `results/validation/tool-validation-2026-11-19T08-41-13-003Z.json` |
| SL | `results/static-analysis/` (Slither output) |
| RL | `docs/RUN_LOG.md` |
| DV | `docs/DEVIATIONS.md` |
| PR | `docs/preregistration_v1_2026-11-18.pdf` |

All latencies in S, E and R are in milliseconds; the paper reports seconds rounded half up to two decimals.

## Design and setup (Sections 4-5)

| Claim in the paper | Value | Evidence |
| --- | --- | --- |
| Pre-registration date | 18 Nov 2026 | PR (title page) |
| IBFT 2.0 replaced by QBFT before any code or data | - | DV row 2026-11-18 |
| Besu version | 26.10.0 | `arm-a-ledger/network/generated/docker-compose.yml` (image tag and digest) |
| etcd version | v3.6.14 | `arm-b-coordinator/docker-compose.yml` (image tag and digest) |
| solc version, optimizer 200 runs, EVM london | 0.8.38 | `arm-a-ledger/package.json`, `arm-a-ledger/scripts/compile.js` |
| Shamir library | shamir-secret-sharing 0.0.4 | `shared/package.json` |
| Every server container limited to 1 CPU | 1.0 | `arm-a-ledger/scripts/gen-network.js` (`cpus: 1.0`), `arm-b-coordinator/docker-compose.yml`, `arm-c-central/docker-compose.yml` |
| Besu heap | 1 GB | `arm-a-ledger/scripts/gen-network.js` (`BESU_OPTS: "-Xmx1g"`) |
| A RPC timeout 2 s, failover to all validators | 2000 ms | `arm-a-ledger/src/chain.js` (`RPC_TIMEOUT_MS`); DV row 2026-11-20 |
| Contract rules (TooEarly, NotTrustee, AlreadySubmitted, BadCommitment; no edit/delete; no trustee change; re-registration reverts) | - | `arm-a-ledger/contracts/ExamRelease.sol` |
| B rules (HTTP 425 before T0, 422 on commitment/signature, put-if-absent) | - | `arm-b-coordinator/src/coordinator.js` |
| Commitment formula | SHA-256("commit:" examId ":" index ":" share) | `ExamRelease.sol` header comment; `shared/src/shares.js` |
| Hardware and software of the host | i7, 16 GB, Windows 11, WSL2 10 GB | PR Section 10 |
| Polling 500 ms with seeded, evenly spaced phase offsets | - | RL rows 2026-11-19 (smoke 6a) |
| Resource sampling every 500 ms | - | `harness/src/docker-stats.js`; VAL (sampler interval) |
| Tool validation: CPU 10.023 CPU-s (+0.23 %), memory +501.28 MiB (+0.26 %), clock max offset 5 ms over 50 pairs | as stated | VAL; RL row 2026-11-19 (6b) |
| Factor levels and cells (Table 2) | as stated | PR Section 6; `harness/scripts/run-main.js` |
| 280 scheduled runs (P: 20 x A, B, C; 11 cells x 10 pairs) | 280 | S `runs.total`; R (280 rows) |
| Exact CI ranks 6 and 15 (20 pairs, 95.86 %), 2 and 9 (10 pairs, 97.85 %) | as stated | PR Section 9; S `H1.exactCI.ranks`, `H1.exactCI.coverage`; E `exact_coverage` |
| Minimum two-sided sign-test p about 1.9e-6 (20 pairs), about 0.002 (10 pairs) | 2 x 0.5^20, 2 x 0.5^10 | PR Section 9 (arithmetic) |
| Bootstrap 10,000 resamples, fixed seed | seed 20261118 | S `bootstrap` |
| F5 setup: +30 s, eager trustees retry every 250 ms, T0 45 s after setup, skew check 30 +/- 5 s | as stated | DV rows 2026-11-20 (F5) and 2026-11-21 |
| Fault-test definitions and expected outcomes (Table 3) | as stated | PR Section 8; DV rows 2026-11-19 / 2026-11-20 |

## Data quality (Section 6, first paragraph)

| Claim | Value | Evidence |
| --- | --- | --- |
| All 280 runs kept | 280 / 280 | S `runs.kept`, `runs.notKept` = [] |
| Sampler errors | 0 | S `quality.samplerErrors` |
| Failed block-period checks | 0 | S `quality.blockPeriodChecksFailed` = [] |
| Values outside bounds | none | S `outOfBounds` = [] |
| Every centre got the correct key in every run | okCentres = M in all 280 rows | R (`okCentres`, `M`); RAW `summary.decryptOracleOk` |
| BP1 block 8 arm A: one trustee "nonce has already been used", 4 of 5 shares, 50/50 centres | as stated | RAW `raw-BP1-b008-A.json`: `trustees[2].reason`, `summary.acceptedShares` = 4, `summary.okCentres` = 50; RL last row |

## RQ1: timeliness and safety (Section 6.1, Figures 2-3, Table 4)

| Claim | Value | Evidence |
| --- | --- | --- |
| H1b: early releases | A 0/130, B 0/130, C 0/20 | S `H1b`; R `earlyCount` (sum 0) |
| Median L95 A, primary cell, with bootstrap CI | 1804.5 [1735.5, 1924] ms | S `cells.P.metrics.L95.medianA`, `ciA`; E row P,L95 |
| Median L95 B | 491.5 [489, 496.5] ms | S `cells.P.metrics.L95.medianB`, `ciB` |
| Median L95 C | 478 [472.5, 480.5] ms | S `referenceC.metrics.L95.medianA`, `ciA` (field "A" holds arm C in this block) |
| Median paired difference | 1321 ms | S `H1.medianDiffMs` |
| Exact 95.86 % CI | [1244, 1498] ms | S `H1.exactCI.lower`, `upper` |
| Decision non-inferior | true | S `H1.nonInferior`, `H1.decision` |
| Sign test 20/20 below delta, p = 9.54e-7 | as stated | S `H1.signTest` |
| Wilcoxon p = 9.54e-7 | as stated | S `H1.wilcoxon` |
| Bootstrap CI of median difference | [1247, 1436] ms | S `H1.bootstrapCI` |
| Ratio L95 A/B 3.70 [3.56, 3.93] | as stated | E row P,L95 `median_ratio_A_over_B`, `ratio_lo`, `ratio_hi` |
| 16 differences in 1.17-1.55 s, 4 in 2.17-2.28 s | as stated | S `H1.differencesMs` (20 values) |
| Share-availability lag A 1.49 s, B 0.04 s (post-hoc definition) | 1.489 / 0.045 s | E row P,shareLag_s; DV row 2026-11-22 (metrics) |
| L50 difference 1.25 s | 1251.5 ms | E row P,L50 |
| All other values in Table 4 | as stated | E rows `P,*`; S `referenceC.metrics.*` for column C; S `gas.P` for gas |
| Sensitivity medians and exact CIs (Figure 3) | per cell | E rows `<cell>,L95`: `median_diff_A_minus_B`, `diff_exact_lo`, `diff_exact_hi` |
| Largest differences: M200 2.59 s, EX1 2.28 s, LOAD20 1.83 s | 2589 / 2278 / 1825 ms | E rows M200, EX1, LOAD20 (L95) |
| JIT30: L95 A 19.6 s, B 18.3 s, difference 0.96 s, ratio 1.05 | 19565 / 18336.5 / 958.5 ms, 1.054 | E row JIT30,L95 |
| BP1 1.31 s, BP5 1.35 s; K5N9 1.60 s | 1306.5 / 1349.5 / 1601 ms | E rows BP1, BP5, K5N9 (L95) |
| Highest exact upper bound in any cell below 5 s | 2920 ms (LOAD20) | E column `diff_exact_hi` (L95 rows) |
| Block-period settings confirmed in every A run | - | S `quality.blockPeriodChecksFailed` = []; RAW `raw-*-A.resources.json` field `blockPeriodCheck` (`wantS`, `gaps`, `medianS`, `ok`) |

## Readiness time (Section 6.2, exploratory, not pre-registered)

| Claim | Value | Evidence |
| --- | --- | --- |
| Median time to ready: A about 111 s, B about 6 s, C 4.4 s | per-cell medians A 110.3-113.0 s, B 5.9-6.5 s, C 4.4 s | R `readySeconds` (median by cell and arm) |

## RQ2: fault tests (Section 6.3, Figure 4)

| Claim | Value | Evidence |
| --- | --- | --- |
| Pass counts for F1-F8, G1 per arm | as in Figure 4 | FV `results[*].passed`, `verdict`; `results/analysis/faults.csv` |
| F5 A: earliest key 246-1362 ms after T0 | min over centres per run, range over 10 runs | FR `faults-F5-b0*-A.json` `centres[*].latencyMs`; RL row 2026-11-21 (group 2) |
| F5 B: key 29.6-29.9 s before T0 in all runs | -29922 to -29614 ms | FR `faults-F5-b0*-B.json` `centres[*].latencyMs`; RL row 2026-11-21 |
| F5 smoke check: honest-node trustees refused with TooEarly until T0 | - | RL row 2026-11-21 (smoke 6d, F5 Arm A) |
| F6 B: censored centres never got the key; A: they did | - | FV (F6 checks); FR `faults-F6-*`; RL row 2026-11-20 (group 3) |
| F7 A 9/10: run b007 kill issued 1 ms before T0, all 50 centres got the key | - | FV `F7/A.failedRuns`; FR `faults-F7-b007-A.json`; RL row 2026-11-20 (group 3) |
| F7 A: centres on the killed node about 6 s | L95 5.86-6.14 s, Lmax 6.01-6.17 s | FR `faults-F7-b0*-A.json` `summary.L95`, `summary.Lmax`; RL |
| F7 B: one run about 1.2 s (leader election) | b005 | FR `faults-F7-b005-B.json`; RL row 2026-11-20 (group 3) |
| F8 A: writes refused, three changes detected; B: edit detected, re-time and deletion not | - | FV `F8` checks; FR `faults-F8-*`; RL row 2026-11-20 (group 4) |
| G1 A: re-registration reverted; B: direct write accepted, honest shares rejected, no key | - | FV `G1` checks; FR `faults-G1-*`; RL row 2026-11-20 (group 4) |
| G1 met by immutability, not multisig | - | DV row 2026-11-20 (G1) |

## RQ3: cost (Section 6.4, Figure 5, Table 4)

| Claim | Value | Evidence |
| --- | --- | --- |
| CPU A 40.5, B 12.4 CPU-s; difference 28.0 [26.8, 28.5]; ratio 3.17 [3.07, 3.25] | 40.536 / 12.378 / 28.001 [26.778, 28.496] / 3.168 [3.072, 3.247] | E row P,cpu_s |
| Memory A 1492, B 137 MB; difference 1357 [1349, 1362]; ratio 10.9 [10.8, 11.2] (post-hoc definition) | 1492.16 / 136.717 / 1356.566 / 10.933 | E row P,mem_MB; DV row 2026-11-22 (metrics) |
| Storage A 2.20, B 0.029 MB | 2.202 / 0.029 | E row P,storage_MB |
| Gas per session 528,713 (range 528,689-528,713); K5N9 951,681 | as stated | S `gas.P`, `gas.K5N9`; REP "Gas per session" |
| C: 1.31 CPU-s, 18.8 MB | 1.305 / 18.809 | S `referenceC.metrics.cpu_s.medianA`, `mem_MB.medianA` |
| CPU ratio range 1.95 (M200) to 5.40 (M10); memory ratio 7.96 to 15.0 | as stated | E column `median_ratio_A_over_B`, rows `*,cpu_s` and `*,mem_MB` |
| CPU B 4.2 s at M10, 32.5 s at M200; A 22.3 s and 63.9 s | 4.175 / 32.451 / 22.328 / 63.871 | E rows M10,cpu_s and M200,cpu_s |

## Static analysis (Section 4.2, Section 9)

| Claim | Value | Evidence |
| --- | --- | --- |
| Slither 0.11.6, 102 detectors, one finding (timestamp, impact Low) | as stated | SL `slither-ExamRelease.txt`, `slither-ExamRelease.json`, `README.md` |

## Figures

| Figure | Source data | Script |
| --- | --- | --- |
| 1 Testbed | design (no data) | `docs/figures/fig_testbed.*` |
| 2 Primary cell | R (cell P), S `H1` | `analysis/make_paper_figures.py` |
| 3 Sensitivity | E (L95 rows) | same |
| 4 Fault tests | S `faults` (same as FV) | same |
| 5 Cost | S `cells.P`, `referenceC` | same |
| 6 Decision framework | PR Section 4; results above | same |

Regenerate: `python analysis/make_paper_figures.py` from the repository root.
