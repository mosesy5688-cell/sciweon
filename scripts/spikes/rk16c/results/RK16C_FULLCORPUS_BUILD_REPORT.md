# RK-16C FULL-CORPUS SUPPLEMENTAL SPIKE — DELTA BUILD REPORT (M1-M4)

**BUILD-ONLY. NO production R2 read. NO metadata HEAD/GET. NO credentialed fetch.
NO workflow dispatch. NO family registered. NO inventory / F3 / F4 / reader /
live API / latest / wrangler change. NO activatable candidate. The 475,112-row
corpus is NOT fetched.** This DELTA report supersedes the prior BUILD report; it
records the 4 BLOCKING corrections (M1-M4) applied on top of PR #272 and the
17 required delta items.

## 0. Delta header

- **New head SHA: `<PM-FILLS-REAL-SHA>`** (the PM fills the real merge/commit SHA;
  the dry-run envelope currently records the pre-correction build_commit
  `abf2a3118dc80e8a730e0b94d2c038b55bbf7681`).
- PR **#272 remains OPEN** (BUILD-ONLY; no merge). Production R2 UNCHANGED.

## 1. Changed-file delta (this correction round)

| File | Change |
| --- | --- |
| `lib/corpus-identity.mjs` | M1 — `consumedObjectKeys()` returns EXACTLY `[manifest, payload]`; `LATEST_POINTER_KEY` renamed to `FORBIDDEN_LATEST_ALIAS_KEY` (export-only, never read). |
| `lib/exact-readonly-guard.mjs` | M2 — NEW stricter guard `instrumentExactReadOnlyClient`: ONLY HeadObject/GetObject of an allowlisted Key; throws on List/non-allowlisted-key/PUT/DELETE/COPY/multipart/latest. |
| `lib/fullcorpus-lock.mjs` | M3 — NEW credential-free lock schema + `validateLock`/`requireLock`/`loadAndRequireLock` (`rk16c-fullcorpus-lock-v1`). |
| `RK16C_FULLCORPUS_LOCK.template.json` | M3 — NEW template (all fields null/placeholder; comment: populated by the founder-gated metadata-only preflight, never fabricated). |
| `lib/resource-guard.mjs` | M4 — NEW process-level memory monitor (heapUsed/heapTotal/rss/external/arrayBuffers) + temp-disk formula + free-space preflight. |
| `lib/r2-readonly-adapter.mjs` | M1/M2/M3/M4 — dry-run = 2 keys only; replaced `executeRead` with two-stage `preflightManifest` + `executeFullRun` (lock-gated, streaming, no decompressed file); new caps. |
| `run-fullcorpus.mjs` | M3 — `--preflight`/`--manifest-key`/`--lock` args; exact two-stage future commands; still refuses `--execute` in BUILD. |
| `SELECTION_RUBRIC.md` | M1 — corrected read-set note (2 keys; latest forbidden; lock-gated). |
| `tests/rk16/rk16c-fullcorpus-adapter.test.ts` | M1-M4 — rewritten suite (22 tests). |
| `results/RK16C_FULLCORPUS_BUILD_REPORT.md` | this DELTA report. |

## 2. Proof latest.json is removed (M1)

`consumedObjectKeys()` returns EXACTLY the two snapshot-namespace keys; the
mutable alias appears in NO read path (code, allowlist, identity envelope
`consumed_object_keys`, dry-run plan). Proven by test
**`M1 — snapshots/latest.json is NOT in any read path`** (both cases:
consumed-keys and dry-run-plan assert latest is absent; `forbidden_keys`
explicitly lists it).

## 3. List-rejected test reference (M2)

The stricter guard `instrumentExactReadOnlyClient` permits ONLY HeadObject +
GetObject of an allowlisted Key. Proven by:
- **`M2 … REJECTS a ListObjectsV2 command (throws)`** — List throws, `list_attempt_count===1`.
- **`M2 … REJECTS a HEAD/GET of a non-allowlisted key (incl. latest)`** — non-allowlisted key (incl. `snapshots/latest.json`) throws.
- **`M2 … PASSES a HEAD/GET of an allowlisted key (mock)`** — allowlisted HEAD/GET pass.
- **`M2 … REJECTS any PUT`** — no write reaches the store.

## 4. Complete EXACT object keys (NO ellipsis)

- manifest: `snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json`
- payload:  `snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz`
- FORBIDDEN: `snapshots/latest.json` (never read).

## 5. Lock schema (M3)

`RK16C_FULLCORPUS_LOCK.json`, schema_version `rk16c-fullcorpus-lock-v1`,
credential-free. REQUIRED fields (12): `snapshot_id`, `production_run_id`,
`manifest_key`, `manifest_etag`, `manifest_byte_size`, `manifest_sha256`,
`payload_key`, `payload_etag`, `payload_byte_size`, `payload_sha256`,
`expected_row_count`, `schema_version`. Validator returns `{ok,errors[]}`;
`require()` THROWS listing every missing/empty field; credential-shaped fields
are rejected. Template: `RK16C_FULLCORPUS_LOCK.template.json` (all null/placeholder;
populated by the founder-gated metadata-only preflight, NEVER fabricated).

## 6. All required identity fields

Identity envelope: snapshot_id, snapshot_production_run_id, manifest_object_key,
consumed_object_keys[] (= the 2 keys), object_byte_size, etag, sha256,
schema_version, expected_row_count, observed_row_count, build_commit,
local_materialization_path, materialization_timestamp, verification_status. The
validator FAIL-CLOSES on ANY mismatch and NEVER auto-switches to latest.

## 7. Fail-before-network test reference (M3)

The full run loads + `require()`s a COMPLETE lock BEFORE any client/network.
Proven by **`M3 … full run require()s a complete lock BEFORE any client
(fail-before-network)`** — asserts `clientMade === false` (no `makeClient`,
no HEAD/GET) for both a missing lock path and an incomplete lock file; throws
`/FAIL BEFORE NETWORK/`.

## 8. Exact PREFLIGHT + FULL-RUN commands (NO optional integrity, no brackets)

```
PREFLIGHT (future gate): node scripts/spikes/rk16c/run-fullcorpus.mjs --preflight --execute --snapshot 2026-06-14/27502029137-1 --manifest-key snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json
FULL RUN  (future gate): node scripts/spikes/rk16c/run-fullcorpus.mjs --execute --lock scripts/spikes/rk16c/RK16C_FULLCORPUS_LOCK.json
```

Both are FOUNDER-GATED and NOT exercised in the BUILD phase (the runner refuses
`--execute` here by design). PREFLIGHT is METADATA-ONLY (manifest key only,
2 MiB cap, NO payload GET); the FULL RUN consumes the founder-reviewed lock.

## 9. Process-level heap/RSS hard limits (M4)

The memory monitor samples `process.memoryUsage()` —
heapUsed/heapTotal/rss/external/arrayBuffers — at an interval (default 250 ms).
Hard ceilings (configurable): max heapUsed = 512 MiB, max RSS = 1 GiB. On breach
it records a BOUNDED failure (`over_heap_used_ceiling` / `over_rss_ceiling`) and
STOPS (it does NOT crash the harness silently). The run report records PEAK
heapUsed/heapTotal/rss/external/arrayBuffers (NOT just V8 heap). **Required Node
old-space hard ceiling:** run with `--max-old-space-size=512`, e.g.
`node --max-old-space-size=512 scripts/spikes/rk16c/run-fullcorpus.mjs --execute --lock …`.

## 10. Temp-disk formula + free-space preflight (M4)

`required_free_bytes = partial_download_slack (≈compressed) +
verified_final_compressed (≈compressed) + decompressed_materialization (0 —
STREAMED, never landed) + temp_index_output (64 MiB) + result_artifacts_12cell
(12 × 8 MiB) + failure_residue (32 MiB) + cleanup_reserve (25% of the subtotal)`.
A free-space PREFLIGHT (`diskPreflight`/`requireDiskPreflight` via
`fs.statfsSync`) checks available disk BEFORE any network read and FAILS BEFORE
NETWORK (or when free space is UNKNOWN) — fail-closed. The full run STREAMS the
gzip payload and writes ONLY the verified compressed `.gz`; **no decompressed
file is ever written to disk** (`decompressed_file_written === false`).

## 11. Updated caps (M4)

`MAX_REQUESTS = 8` (2 keys × HEAD+GET + slack), `MAX_OBJECTS = 2` (corrected
2-object set), `MAX_TOTAL_BYTES = 1.5 GiB`, `MAX_MANIFEST_BYTES = 2 MiB`
(preflight metadata cap), plus the memory ceilings (heapUsed 512 MiB / RSS 1 GiB)
and the disk free-space ceiling from the formula above.

## 12. Fixture results

BUILD fixture: **LOCAL 2026-05-13 corpus (corpus-grounded stand-in, 8,351 rows;
SMALLER/OLDER than the 475k production corpus — NOT a production read)**; CI
falls back to a deterministic SYNTHETIC fixture (LABELED). The matrix ran **12
cells**; rubric outcome **CANDIDATE_SELECTED**. This BUILD-phase winner is NOT a
production decision — production-degree re-validation requires the founder-gated
two-stage read (PREFLIGHT then lock-gated FULL RUN).

## 13. CI note

`npx vitest run tests/rk16` — 6 files, 54 tests, 0 failures (includes the
rewritten `rk16c-fullcorpus-adapter.test.ts`, 22 tests). No regression in
`tests/factory/rk16` / `tests/worker/rk16`. Corpus-grounded tests
skip-when-absent with an explicit reason. (Verbatim summaries in the build
session.)

## 14. DRY-RUN output (regenerated — ONLY the 2 keys, no latest, no network)

```
proposed_object_keys (= allowlist):
  snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json
  snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz
forbidden_keys:
  snapshots/latest.json
estimated_request_count: 4   (1 HEAD + 1 GET per object; no List)
estimated_object_count:  2
estimated_total_bytes:   62,980,096   (~60 MiB; EXPECTED-ONLY)
hard_caps: max_requests=8  max_objects=2  max_total_bytes=1,610,612,736  max_manifest_bytes=2,097,152
within_caps: true   network_performed: false
```

## 15. Proof production snapshot is unchanged

By CONSTRUCTION: the BUILD phase performs NO network call (dry-run only). The
`--execute` paths route the ONLY client through `instrumentExactReadOnlyClient`,
which permits ONLY HeadObject/GetObject of an allowlisted Key and THROWS on
List/non-allowlisted-key/PUT/DELETE/COPY/multipart/latest — so no write, no
latest-mutation, no republish, no discovery is reachable. The FULL RUN cannot
even reach the network without a complete founder-reviewed lock. `put_count ==
delete_count == list_count == write_attempt_count == 0` is asserted by tests.

## 16. Cleanup procedure

`node scripts/spikes/rk16c/run-fullcorpus.mjs --cleanup [--snapshot <id>]`
removes the `os.tmpdir()` materialization directory. Programmatic: `cleanup()`
in `lib/r2-readonly-adapter.mjs`.

## 17. Status

PR #272 OPEN; BUILD-ONLY; production unchanged; no merge; no governance edits;
all spike files ≤ 250 lines. The two-stage founder-gated read remains the only
path to real production-degree numbers.
