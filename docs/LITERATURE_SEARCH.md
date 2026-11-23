# Literature search log

Purpose: check the claim in Section 2 of the paper that no exam-focused study isolates the ledger's contribution by comparing it with the same threshold scheme coordinated without a ledger (pre-registration, Section 2: "to confirm after Scopus/Scholar search").

## Protocol

| Item | Value |
| --- | --- |
| Date | 2026-11-23 (search run 08:40-08:45 UTC) |
| Index | OpenAlex (open index of Crossref, arXiv, PubMed, repositories and others), queried through its public API |
| Field | Titles and abstracts (`filter=title_and_abstract.search:<query>`) |
| Language / years | No filter (English query terms) |
| Deviation | The pre-registration named Scopus / Google Scholar. Neither was accessible from the analysis environment; OpenAlex was used instead (logged in `docs/DEVIATIONS.md`). |
| Screening | All records screened by title; abstracts (or publisher descriptions) read for 23 records judged possibly relevant; full texts read for the closest works available locally (`Downloads/Exam-Leak-TimedRelease-Prior-Studies`). |

Request pattern (S1 as example):

```
https://api.openalex.org/works?filter=title_and_abstract.search:<URL-encoded query>&per-page=200&select=doi,title,publication_year
```

## Queries and counts

| ID | Query | Records |
| --- | --- | --- |
| S1 | ("timed release" OR "timed-release" OR "time-release" OR "time-lock" OR "time lock" OR "self-emerging") AND ("smart contract" OR blockchain) | 236 |
| S2 | ("question paper" OR "exam paper" OR "examination paper" OR "test paper") AND (blockchain OR "smart contract" OR "secret sharing" OR "time-lock" OR "timed release") | 53 |
| S3 | ("secret sharing" OR "threshold cryptography" OR "threshold scheme") AND (exam OR examination OR "question paper") | 58 |
| S4 | ("secret sharing" OR "threshold cryptography") AND "smart contract" AND (release OR disclosure OR reveal OR "time-lock") | 22 |
| S5 | (exam OR examination) AND (leak OR leakage) AND (blockchain OR "smart contract") | 66 |
| S6 | (blockchain OR "smart contract") AND ("key release" OR "timed release" OR "time-lock" OR "time lock") AND (benchmark OR baseline OR "non-blockchain" OR centralized OR etcd OR raft) | 43 |
| S7 | (blockchain OR "distributed ledger" OR "smart contract") AND ("distributed database" OR etcd OR raft OR "crash fault" OR "replicated database") AND (benchmark OR "performance comparison" OR versus OR dichotomy) | 55 |
| | Total (with overlaps) | 533 |

Most S1 records concern hash time-locked contracts for cross-chain swaps and payment channels, which use "time lock" in a different sense; they were excluded by title.

## Screened-in records (abstract or full text read)

| Record | Why it matters | Matched non-ledger threshold baseline? | Read |
| --- | --- | --- | --- |
| Pasha 2026, Zenodo 10.5281/zenodo.21888576 | Closest design: AES-256-GCM paper key, release capability split by (k, n) Shamir among custodians, quorum time authority, per-centre key wrapping | No: qualitative comparison with blockchain-anchored distribution; prototype and quantitative evaluation listed as future work | Description page |
| Tiwari, Yadav, Kadian 2026, LNNS, 10.1007/978-981-96-8107-5_3 | Threshold ECDSA for exam paper leakage | No: computation time only (14.48 ms total) | Abstract |
| Gupta, Bhardwaj, Tripathi, Yadav 2026, LNNS, 10.1007/978-3-032-14757-8_45 | Hybrid threshold decryption for exam papers | No: computation time only (max 151 ms) | Abstract |
| Shukla et al. 2025, IEEE GCWCN, 10.1109/GCWCN66157.2025.11448476 | Hyperledger Fabric, multi-signature, time-locked release for question papers | No | Abstract |
| Sonwane et al. 2026, IEEE ICITSIF, 10.1109/ICITSIF69060.2026.11608859 | Private Ethereum, smart contracts automate time-based release | No | Abstract |
| Farhan et al. 2025 (ASSURE-EXAM), ACSACW, 10.1109/ACSACW69556.2025.00042 | Blockchain time lock + access control for exam papers | No: gap analysis vs. traditional systems | Abstract |
| Islam, Kader, Shin 2018 (BSSSQS), arXiv:1812.03917 | Encrypted question papers on chain, timestamp lock | No: feature comparison with centralised exam systems (Table 2 of the paper) | Full text |
| Li, Majumdar, Pournaras 2025, IEEE TNSM | Smart-contract time release with verifiable secret sharing | No: measured against time-lock puzzles (decryption-time deviation 18-30 s on Arbitrum Sepolia) | Full text |
| Li & Palanisamy 2022 (SilentDelivery), IEEE TSC | Threshold sharing + smart contracts, Rinkeby | No: compared with another decentralised protocol (Kimono) | Full text |
| Stengele et al. 2021 (ETHTID), BCCA | Threshold information disclosure on Ethereum, gas evaluation | No | Full text |
| Wang & Palanisamy 2023, J. Computer Security, 10.3233/JCS-230001 | Attack-resilient blockchain timed data release (reputation) | No | Abstract |
| Ruan et al. 2021, SIGMOD, 10.1145/3448016.3452789 | Blockchains (Quorum, Fabric) vs. distributed databases incl. etcd | General transactions; no threshold release, no fault tests | Abstract |
| Sharma et al. 2019, SIGMOD, 10.1145/3299869.3319883 | Fabric vs. database concepts | Not a matched comparison of release | Abstract (not cited) |
| Kapse et al. 2022 (iSSSC); SecureQ 2024 (INNOVA); Sharma et al. 2026 (IJICS); EXAM-VAULT 2026; Rajalatchi et al. 2025; Majumdar 2026 (AJCST); Yuan et al. 2023 (Sci. Rep.); Wang & Palanisamy 2022 (ICBC), 2025 (CIC); Palanisamy 2025 (IWSPA talk) | Blockchain/IPFS or server-side time-lock designs for exam papers or timed release | No | Abstract (not cited unless listed in the paper) |

Result: no record compares the ledger with the same threshold scheme coordinated by a replicated non-ledger service, measures synchronised release latency to many centres, or runs scripted fault tests on both. The closest work (Pasha 2026) proposes a non-ledger threshold design and leaves quantitative evaluation to future work.

Limitations: one open index; English query terms; title-level screening of 533 records by one reviewer (with AI assistance); counts will change as OpenAlex is updated.
