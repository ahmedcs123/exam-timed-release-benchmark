# Deviations from the pre-registered design

Every change to the frozen design (pre-registration v1, 18 Nov 2026) is recorded here before it is applied.
Changes made after seeing any data are marked **post-hoc** and reported as such in the paper.

| Date | Section of design | What changed | Why | Before or after data? |
| --- | --- | --- | --- | --- |
| 2026-11-18 | Section 5 (Arm A), Sections 8, 10, 11 | Consensus for Arm A changed from IBFT 2.0 to QBFT (still Hyperledger Besu, 4 validators, block period 2 s) | Besu documentation recommends QBFT for new private networks; IBFT 2.0 is supported only for existing networks. Both are BFT with immediate finality and need at least 4 validators, so the comparison with Arm B is unchanged | Before any data (no runs yet); not post-hoc |
