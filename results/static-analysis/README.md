# Static analysis of the Arm A contract (Slither)

Run on 2026-11-23, after all measured runs (the pre-registration, Section 11, says static-analysis results are reported; the run itself was done after data collection, see docs/DEVIATIONS.md).

| Item | Value |
| --- | --- |
| Contract | `arm-a-ledger/contracts/ExamRelease.sol` (unchanged since the main runs, commit b9c1df8) |
| Tool | Slither 0.11.6 (crytic-compile 0.4.2), 102 detectors, default settings |
| Compiler | solc 0.8.38+commit.1835d247 (static Linux build from the Solidity GitHub release v0.8.38, SHA-256 `65c3180a336eabb6bdc4bbd49cc405aeb233976964ae6c11fba2a6c8be8f3243`) |
| Compiler settings | `--optimize --optimize-runs 200 --evm-version london` (same as `arm-a-ledger/scripts/compile.js`) |
| Command | `slither ExamRelease.sol --solc <path-to-solc> --solc-args "--optimize --optimize-runs 200 --evm-version london" --json slither-ExamRelease.json` |
| Result | 1 finding: detector `timestamp`, impact Low, confidence Medium |

The finding: `submitShare` compares `block.timestamp < e.t0` (line 63). This comparison is the release rule itself (no share before T0). The risk it flags, a validator that manipulates block time, is the scenario tested in F5 (one validator 30 s ahead), which Arm A passed 10/10 (`results/faults/fault-verdicts.json`).

Files:

- `slither-ExamRelease.txt`: console output
- `slither-ExamRelease.json`: machine-readable output (absolute paths of the analysis machine replaced by repository paths)
