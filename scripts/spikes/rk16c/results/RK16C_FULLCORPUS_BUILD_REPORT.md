# RK-16C FULL-CORPUS SUPPLEMENTAL SPIKE — BUILD REPORT (TEMPLATE)

**BUILD-ONLY. NO production R2 read. NO credentialed fetch. NO workflow dispatch.
NO family registered. NO inventory / F3 / F4 / reader / live API / latest /
wrangler change. NO activatable candidate. The 475,112-row corpus is NOT
fetched in this phase.** A parameter-calibration spike to re-validate page-size +
partition selection at production scale. NOT production. The BUILD phase fills
every section it can WITHOUT a production read; the production-degree numbers are
filled only by the founder-gated READ-ONLY RUN GATE (`--execute`).

## 1. Harness architecture

- `run-fullcorpus.mjs` — entrypoint. DEFAULTS to `--dry-run` (no network).
- `lib/r2-readonly-adapter.mjs` (H) — read-only acquisition adapter; dry-run
  computes the plan with zero network; `--execute` is the future RUN GATE.
- `lib/corpus-identity.mjs` (C) — identity envelope + fail-closed validator.
- `lib/rubric.mjs` (F) — machine-checkable hard gates + metrics + tie-breaking.
- `lib/fullcorpus-cells.mjs` (E/G glue) — one matrix cell -> correctness + metrics.
- `lib/real-degree.mjs` (G) — degree distribution + max-degree classification.
- `lib/repro-envelope.mjs` (D) — reproducibility recorder.
- `lib/fixture-source.mjs` — BUILD fixture (local 2026-05-13 corpus else synthetic).
- Reuses (by import, unmodified): existing RK-16C spike libs; A1
  `src/worker/lib/rk16/*`; A2/A3 `scripts/factory/lib/rk16/*`; the P8R1
  read-only guard `instrumentReadOnlyClient`; `snapshot-context.ts`;
  `snapshot-identity.js`; `zstd-helper.js`.

## 2. Corpus identity contract (C)

Pinned candidate: `2026-06-14/27502029137-1`; `expected_row_count = 475112`
(EXPECTED-ONLY until a read verifies it). Envelope fields: snapshot_id,
snapshot_production_run_id, manifest_object_key, consumed_object_keys[],
object_byte_size, etag, sha256, schema_version, expected_row_count,
observed_row_count, build_commit, local_materialization_path,
materialization_timestamp. The validator FAIL-CLOSES on ANY mismatch
(identity / hash / schema / row-count) and NEVER auto-switches to latest.

## 3. Full 12-cell matrix definition (E)

record_count_target ∈ {128, 256, 512, 1024} × partition_policy ∈ {P0_none,
P1_is_active, P2_is_active×activity_type} = 12 comparable cells. Reuses the
param-matrix / partitioned-sublist / projection-page / posting-directory /
cursor / read-budget substrate. A bad combo is a RECORDED bounded failure
(`bounded_failures > 0`, hard gates fail), NEVER silently dropped. The matrix
reads rows from the read-only adapter's LOCAL materialized path — NEVER
production R2 directly.

## 4. Pre-registered rubric (F)

See `../SELECTION_RUBRIC.md` (versioned `rk16c-fullcorpus-rubric-v1`,
committed BEFORE any full read) and `../lib/rubric.mjs`. Hard gates +
comparative metrics + tie-breaking + NO-RATIFIABLE-CANDIDATE clause are defined
there and enforced in code.

## 5. Read-only adapter + safety boundaries (H)

- SAFE BY DEFAULT: dry-run performs NO network call.
- Real read requires BOTH `--execute` AND a snapshot pin; otherwise THROWS.
- Explicit object ALLOWLIST (default-deny) = exactly the 3 pinned keys.
- The real client is wrapped by `instrumentReadOnlyClient`: only List/Head/Get
  pass; any PUT/DELETE/COPY/latest-mutation increments a counter and THROWS
  before reaching the store.
- Hard caps (fail-closed): `MAX_REQUESTS = 12`, `MAX_TOTAL_BYTES = 1.5 GiB`;
  HEAD size is checked BEFORE the GET.
- Local destination OUTSIDE the repo (`os.tmpdir()`); atomic temp-then-rename;
  partial-download detection (size mismatch -> throw + unlink).
- sha256 verification before use; mismatch -> fail-closed, file removed.
- Credential redaction in all logs; `cleanup()` command removes the dir.

## 6. Fixture test results (BUILD phase, filled)

BUILD fixture: **LOCAL 2026-05-13 corpus (corpus-grounded stand-in, 8,351 rows;
SMALLER/OLDER than the 475k production corpus — NOT a production read)**. When
absent (CI), a deterministic SYNTHETIC fixture is used (LABELED). The matrix ran
**12 cells**; rubric outcome **CANDIDATE_SELECTED** with winner **rt256_P0_none**
on this stand-in (ranking top: rt256_P0_none < rt128_P0_none < rt512_P0_none).
This BUILD-phase winner is NOT a production decision — production-degree
re-validation requires the READ-ONLY RUN GATE.

## 7. CI results (I)

`tests/rk16/rk16c-fullcorpus-*.test.ts`: adapter dry-run/no-network + identity
fail-close + read-only-guard + execute fail-closed paths; harness end-to-end on
a small synthetic fixture; deterministic-replay (identical output hashes); rubric
gate + NO-RATIFIABLE-CANDIDATE; real-degree classification; corpus-grounded
tests skip-when-absent with an explicit reason. (See the build session for the
verbatim vitest summary.)

## 8. DRY-RUN output (exact proposed production object keys + estimates)

```
snapshot_id: 2026-06-14/27502029137-1   expected_row_count: 475112
proposed_object_keys (= allowlist):
  snapshots/latest.json
  snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json
  snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz
estimated_request_count: 6   (1 HEAD + 1 GET per object; no List)
estimated_total_bytes:   62,988,288   (~60 MiB; EXPECTED-ONLY)
hard_caps: max_requests=12  max_total_bytes=1,610,612,736
within_caps: true   network_performed: false
```

## 9. Local temp-disk requirement

The materialized corpus + per-cell shard/dir bytes live under `os.tmpdir()`.
BUILD-phase fixture run used ~5.5 MB temp. A production-scale run should provision
for the corpus object (~60 MiB compressed est.) plus per-cell substrate output.

## 10. Estimated peak-heap ceiling

Per-page parsed heap is hard-capped at the A1 4 MiB ceiling (NEVER raised); a
cell that would exceed it is a recorded bounded failure. BUILD-phase observed
process peak heap ≈ 44 MB on the 8,351-row stand-in.

## 11. Cleanup procedure

`node scripts/spikes/rk16c/run-fullcorpus.mjs --cleanup [--snapshot <id>]`
removes the os.tmpdir() materialization directory. Programmatic: `cleanup()` in
`lib/r2-readonly-adapter.mjs`.

## 12. Proof production snapshot is unchanged

By CONSTRUCTION: the BUILD phase performs NO network call (dry-run only); the
`--execute` path routes the ONLY client through `instrumentReadOnlyClient`, which
permits ONLY List/Head/Get and THROWS on any PUT/DELETE/COPY — so no write, no
latest-mutation, no republish is reachable. `put_count == delete_count ==
write_attempt_count == 0` is asserted by the adapter + the read-only-guard test.

## 13. The EXACT command a future READ-ONLY RUN GATE would use

```
node scripts/spikes/rk16c/run-fullcorpus.mjs --execute \
  --snapshot 2026-06-14/27502029137-1 \
  --expected-rows 475112 \
  --expected-sha256 <pinned-corpus-sha256>
```

This is FOUNDER-GATED. It is NOT exercised in the BUILD phase (the runner
refuses `--execute` here by design; the real read is `executeRead()` in
`lib/r2-readonly-adapter.mjs`, to be invoked only under explicit founder
authorization with a verified pin).
