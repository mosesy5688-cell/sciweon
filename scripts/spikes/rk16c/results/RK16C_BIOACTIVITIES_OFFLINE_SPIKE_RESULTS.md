# RK-16C Bioactivities Offline Spike — Results

**OFFLINE substrate-conformance + parameter-selection experiment.** NO production
R2, NO network, NO workflow dispatch. NO family registered. NO inventory / F4 /
reader / latest / API / wrangler change. NO activatable production candidate. The
spike MAY eliminate / propose / tighten; it may NOT raise any section-17 hard
cap, lock production config, or authorize family implementation.

## Corpus provenance (CORPUS-GROUNDED inputs)
- source_path: `snapshots/2026-05-13/bioactivities.jsonl.gz`
- sha256: `ab4c3f1e97987323eccbcbcf90bd0196525d72f5cf59ca7b1c580f3a08164b71`
- record_count: 8351
- note: LOCAL 2026-05-13 snapshot (offline file, NOT production R2). Smaller + older than production (~475,112 rows) and contains NO degree-43,364 target; heavy-hitter results use a synthetic fixture.

## Canonical authority
- record_total: 8351; entity_count: 8351
- 1 record = 1 NXVF entity, stored once: **PASS**
- key: sciweon::bioactivity::<id> e.g. sciweon::bioactivity::CHEMBL_ACT_13517848
- canonical shard sha256: `e55f55e04f1138d50d7cad918c138e8e7136afc50b9f1377791727a6d2fc48cd`

## Two materialized axes (CORPUS-GROUNDED)
- **compound axis** key = row compound_id — distinct_keys=294, pages=294, two_level_keys=0, max_degree=100
- **target axis** key = `chembl:<target_id>` (REQUIRED top-level target_id = authority) — distinct_keys=976, pages=977, two_level_keys=0, max_degree=778
- **uniprot vs target_id coverage**: target_id 100% (authority) vs uniprot 33.56% (optional alias). rows_with_uniprot_alias=2803, distinct_alias_keys=586. target_id is the REQUIRED authority (100% coverage); uniprot is an OPTIONAL alias to the same target family, NOT the authority.

## Projection == project(canonical, policy)
- rows_checked=8351, mismatches=0
- projection is a pure, reproducible function: **PASS**
- LIST reads projection pages ONLY (0 canonical reads) — see read-budget proof.

## Parameter matrix (CORPUS-GROUNDED)
Subject: busiest corpus target_id=CHEMBL612545 (degree 778). Seal on the FIRST of record_count, compressed_bytes, parsed_heap. Hard parsed-heap cap = 4096 KiB per page (NEVER raised).

| record_target | compressed_ceiling | pages | avg comp | p95 comp | avg parsed | p95 parsed | max parsed heap | within 4MiB cap | deterministic |
|---|---|---|---|---|---|---|---|---|---|
| 128 | 256KiB | 7 | 11.1 KiB | 12.8 KiB | 77.5 KiB | 89.4 KiB | 89.4 KiB | PASS | PASS |
| 128 | 512KiB | 7 | 11.1 KiB | 12.8 KiB | 77.5 KiB | 89.4 KiB | 89.4 KiB | PASS | PASS |
| 128 | 1MiB | 7 | 11.1 KiB | 12.8 KiB | 77.5 KiB | 89.4 KiB | 89.4 KiB | PASS | PASS |
| 256 | 256KiB | 4 | 21.5 KiB | 28.3 KiB | 135.7 KiB | 178.6 KiB | 178.8 KiB | PASS | PASS |
| 256 | 512KiB | 4 | 21.5 KiB | 28.3 KiB | 135.7 KiB | 178.6 KiB | 178.8 KiB | PASS | PASS |
| 256 | 1MiB | 4 | 21.5 KiB | 28.3 KiB | 135.7 KiB | 178.6 KiB | 178.8 KiB | PASS | PASS |
| 512 | 256KiB | 2 | 40.7 KiB | 29.6 KiB | 271.3 KiB | 185.3 KiB | 357.4 KiB | PASS | PASS |
| 512 | 512KiB | 2 | 40.7 KiB | 29.6 KiB | 271.3 KiB | 185.3 KiB | 357.4 KiB | PASS | PASS |
| 512 | 1MiB | 2 | 40.7 KiB | 29.6 KiB | 271.3 KiB | 185.3 KiB | 357.4 KiB | PASS | PASS |
| 1024 | 256KiB | 1 | 79.5 KiB | 79.5 KiB | 542.6 KiB | 542.6 KiB | 542.6 KiB | PASS | PASS |
| 1024 | 512KiB | 1 | 79.5 KiB | 79.5 KiB | 542.6 KiB | 542.6 KiB | 542.6 KiB | PASS | PASS |
| 1024 | 1MiB | 1 | 79.5 KiB | 79.5 KiB | 542.6 KiB | 542.6 KiB | 542.6 KiB | PASS | PASS |

**Selected candidate (CORPUS-GROUNDED CANDIDATE):** record_count_target=512, compressed_bytes_ceiling=512 KiB, parsed_heap_ceiling=4096 KiB. derived from 2026-05-13, 8,350 rows (smaller+older than production 475,112; no degree-43,364 target). Production-scale follow-up required.

**Rejected sets + reasons:** record_target=128 (too many pages -> more cursor rounds + manifest/dir overhead at no heap benefit); compressed_ceiling=256KiB (seals early, inflates page count); record_target=1024 with 1MiB ceiling (largest parsed pages, closer to the 4 MiB cap with no serving benefit at corpus scale). 512 / 512KiB balances page count vs per-page heap while staying well under every hard cap.

## Heavy-hitter (SYNTHETIC / PARAMETER CANDIDATE)
- synthetic degree = 43364 (corpus has no such target; max corpus target degree = 778)
- pages = 85; PageRef count > 64 -> mandatory two-level: **PASS** (directory_depth=1, reason=count)
- **LIST read-budget proof** (single request, worst case): control=1 (<=4), posting=4 (<=4), canonical=0 (==0), total=5 (<=8) -> **PASS**
- full traversal across 22 bounded cursor requests; rows_traversed=43364; complete=**PASS** (NO single-request scan-to-fill)
- SYNTHETIC fixture (corpus has no degree-43,364 target). A production-scale corpus-grounded heavy-hitter spike is the follow-up.

## Partition comparison (CORPUS-GROUNDED)
Subject: busiest corpus target_id=CHEMBL612545 (degree 778).

| strategy | partitions | total pages | cursor rounds (est) |
|---|---|---|---|
| P0_none | 1 | 2 | 1 |
| P1_is_active | 3 | 4 | 1 |
| P2_is_active_x_activity_type | 13 | 13 | 4 |

**Winner (CORPUS-GROUNDED CANDIDATE): P0_none.** At corpus scale the busiest target fits in few pages; P1/P2 add manifest + duplicated-bytes overhead without enough selectivity benefit. P1 (is_active) is the proposed follow-up to evaluate at production degree.

## Referential integrity (exhaustive)
- projection_record_count=8351, canonical_resolved=8351
- dangling_reference_count=0, content_hash_mismatch_count=0
- clean: **PASS**
- referential_integrity_attestation_hash: `326e39abda1359c6c728288008999d36c6b1b5ac2cb9387db2fcca4d02e9a743` (substrate verification only, NOT a production seal)

## Determinism
- canonical shard byte-identical on rebuild: **PASS** (sha256 match: PASS)
- every matrix combo deterministic: **PASS**

## Codec activation guard
- detected codec_impl: wasm
- native artifact activatable: false
- WASM-fallback artifact activatable=false; assertActivatableCodec throws for WASM: **PASS**
- A WASM-fallback artifact is dev-diagnostic only; assertActivatableCodec THROWS for it. The spike does NOT relax the contract for missing native zstd.

## Remaining uncertainties
- **Production-scale follow-up (REQUIRED):** the corpus is 2026-05-13 / 8351 rows — smaller + older than production (~475,112) and has NO degree-43,364 target. The heavy-hitter results are SYNTHETIC. A production-scale corpus-grounded spike must re-validate page-size + partition selection at real degree + real value/comment cardinality.
- The selected page-size + P0 partition choices are CANDIDATES, not locked production config.
- Compressed-byte estimates use zstd level 3 (the substrate default); production dictionary effects are not modeled here.
- The cursor is UNSIGNED/offline; an HMAC is a precondition of any public cutover (explicitly out of scope).
