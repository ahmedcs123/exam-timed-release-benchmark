# Exam Timed-Release Benchmark

**When Does a Ledger Help? A Decision Framework and Matched Benchmark for Threshold Time-Released Examination Papers**

Author: Ahmed A. Aboessa

## Status

- **18 Nov 2026 – Pre-registration v1.** The research design (questions, hypotheses, margins, decision rules, metrics, run schedule, failure tests and statistics) is frozen in `docs/preregistration_v1_2026-11-18.*` before any code is written or any data are collected.
- Any later change to the design is logged in `docs/DEVIATIONS.md` and reported as post-hoc in the paper.

## What this repository will contain

| Folder | Content |
| --- | --- |
| `docs/` | Pre-registration, deviations log, run log |
| `shared/` | Exam generator, AES-256-GCM encryption, Shamir split/combine, commitments (identical for all arms) |
| `arm-a-ledger/` | Solidity release contract + 4-validator Hyperledger Besu QBFT network (changed from IBFT 2.0 before any data; see docs/DEVIATIONS.md) |
| `arm-b-coordinator/` | Coordinator REST service + 3-node etcd cluster |
| `arm-c-central/` | Single key server (reference arm) |
| `harness/` | Run scheduler, randomised run order, Docker stats sampler, fault-injection scripts F1–F8, G1 |
| `analysis/` | Python scripts that regenerate every table and figure from raw run outputs |
| `results/raw/` | Raw run outputs (CSV), never edited by hand |

## Data

Synthetic data only: random exam files with a fixed seed, synthetic trustees and exam centres. No real exams and no personal data.
