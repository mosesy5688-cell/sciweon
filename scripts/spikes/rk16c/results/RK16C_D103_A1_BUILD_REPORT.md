# RK-16C D-103 A1 TWO-MANIFEST PREFLIGHT — BUILD REPORT

**BUILD-ONLY. NO production R2 read. NO metadata HEAD/GET against R2. NO
credentialed fetch. NO workflow dispatch / rerun. NO env approval. NO payload
read. NO family registered. NO carrier merge / new tag / tag move. PR #272 stays
OPEN. Production snapshot `2026-06-14/27502029137-1` UNCHANGED.**

This report supersedes the M1-M4 delta report for the preflight design. It records
the D-102 + D-103 correction: the metadata preflight now validates **two**
metadata manifests (root seal + deterministic per-file manifest sibling) under the
founder-ratified **A1** trust anchor.

## 0. Identities

- **New AUDITED_RUNNER_SHA: `7e4fa65d38e8b8b359c82070432db952b670b26f`** (the
  corrected runner; supersedes the consumed D-102 runner
  `b0b8246e8ad77742d1aafd0720c5b4dd409d0b44`).
- **WORKFLOW_DEFINITION_SHA:** the PR #272 head commit that carries the repinned
  workflow + this report (`git rev-parse HEAD` on `feat/rk16c-fullcorpus-spike-build`).
- **Consumed / SPENT (NOT reused — D-103 §14):** run `27556302525`; runner
  `b0b8246…`; tag `rk16c-manifest-preflight-7ef1c35`. Not rerun, not moved.
- **Trust-anchor mode:** `producer-contract-derived-sibling-v1`;
  `root_directly_references_file_manifest = false` (A1 is an auditable
  compatibility chain, NOT direct cryptographic root linkage).

## 1. Changed-file delta

| File | Change |
| --- | --- |
| `lib/two-manifest-preflight.mjs` (NEW) | Pure A1 validation: `validateRootSeal` (identity + recomputed `manifest_hash` + payload exactly-once in `satellite_inventory`), `deriveObjectPrefix`/`deriveFileManifestKey`, `validateFileManifest`, `normalizeSatelliteInventory`, `reconcileFilesWithInventory` (set-level), `extractBioactivitiesEntry` (target-level), `assembleCandidateLock`. |
| `lib/corpus-identity.mjs` | `objectPrefixOf` + `fileManifestObjectKey` (deterministic sibling) + `metadataPreflightKeys` (the 2 metadata keys). |
| `lib/r2-readonly-adapter.mjs` | `preflightManifest` rewired to read EXACTLY the two metadata objects (seal then sibling), allowlist = those two keys only, root/per-file/combined byte caps, derived-key==expected asserted BEFORE the 2nd read; `executeFullRun` reads v2 field names + refuses unless `authorized_for_payload_read===true`. |
| `lib/fullcorpus-lock.mjs` | Lock v2 (`rk16c-fullcorpus-lock-v2`): 24 required integrity/identity fields, sha256-format checks, `trust_anchor_mode` + `root_directly_references_file_manifest===false` validated, credential-free. |
| `lib/preflight-control.mjs` | `runPreflight` consumes the assembled candidate, stamps UNRATIFIED; `extractPayloadPins` (single-manifest) removed. |
| `RK16C_FULLCORPUS_LOCK.template.json` | v2 shape (trust-anchor fields + 3 identities). |
| `.github/workflows/rk16c-manifest-preflight.yml` | Repinned checkout `ref` + `AUDITED_RUNNER_SHA` → `7e4fa65…`; boundary doc → 2 metadata objects / ≤8 requests / ≤4 MiB combined; step renamed two-manifest. Command UNCHANGED (`--manifest-key` = root seal key). |
| `tests/rk16/rk16c-two-manifest.test.ts` (NEW) | 21 tests — D-103 §11 cases + fail-closed matrix. |
| `tests/rk16/rk16c-fullcorpus-runner.test.ts` / `-adapter.test.ts` / `-workflow-sim.test.ts` | Updated to the two-manifest flow + lock v2. |

## 2. object_prefix derivation evidence

`objectPrefixFor(snapshotId) = snapshots/<snapshot_id>/` — `scripts/factory/lib/snapshot-identity.js:67-69`. Mirrored by the spike `objectPrefixOf` (`lib/corpus-identity.mjs`) and `deriveObjectPrefix` (`lib/two-manifest-preflight.mjs`). Validated: `validateRootSeal` asserts `seal.object_prefix === snapshots/<pinned snapshot_id>/`.

## 3. manifest.json key derivation evidence

`<validated object_prefix>manifest.json`. Producer: `snapshot-builder.js:171-172` writes `manifest.json` to the snapshot dir; `snapshot-uploader.js:83-101` uploads every top-level file to `${objectPrefix}${fname}` via `putCreateOnly` (live F4). For `27502029137-1` → `snapshots/2026-06-14/27502029137-1/manifest.json`. Derived ONLY from the validated prefix (`deriveFileManifestKey`); `preflightManifest` asserts `deriveFileManifestKey(seal.object_prefix) === fileManifestObjectKey(snapshot)` **before** the second read — never from CLI/List/latest.

## 4. Proof manifest.json is NOT root-inventory-listed

The seal `required_inventory` = `[compoundsManifestKey, xrefIndexKey?, searchProjectionKey?, neg.validationProbeKey?] ∪ satellite_inventory` (`stage-4-activate.js:99-134`); `satellite_inventory = requiredSatelliteKeys(prefix) = SATELLITE_INVENTORY.map(e => `${prefix}${e.key_suffix}`)` (`snapshot-inventory.js:213-215`). `SATELLITE_INVENTORY` (`snapshot-inventory.js:71-121`) + `STRUCTURED_INVENTORY` (`:148-206`) contain NO `manifest.json` entry. ⇒ `manifest.json` is in neither list. (Test: `rk16c-two-manifest.test.ts` "root seal need NOT list manifest.json".)

## 5. Proof bioactivities payload IS root-inventory-listed exactly once

`SATELLITE_INVENTORY` has one entry `key_suffix: 'bioactivities.jsonl.gz'` (`snapshot-inventory.js:93-99`) → `satellite_inventory` carries `<prefix>bioactivities.jsonl.gz` exactly once. `validateRootSeal` fail-closes if the payload key occurs 0 or >1 times.

## 6. Producer-contract create-only co-publication evidence

`snapshot-uploader.js:96` `putCreateOnly(...)` (live F4, create-only IfNoneMatch:'*' — `snapshot-identity.js:182-194`); orchestration `stage-4-upload.js:151-183` runs **builder → uploader → shard-publish/seal** (seal written LAST). So `manifest.json`, all satellite payloads, and the seal are co-published under the same immutable prefix by one run.

## 7. files[] satellite-projection rule (from producer code)

A seal `satellite_inventory` entry is `<object_prefix><key_suffix>`; the matching `manifest.files[]` entry has `filename === <key_suffix>` (`snapshot-builder.js:140-151` sets `filename:`<fname>.gz``; `requiredSatelliteKeys` uses the same `key_suffix`). Projection = `{ f ∈ files : f.filename ∈ normalize(satellite_inventory) }` (normalize = strip validated prefix). Extra non-satellite files[] entries (e.g. `xref-index.json.gz`, `compounds-search.jsonl.gz`) are allowed and NOT treated as satellites. Reconciliation requires a bijection: every normalized satellite filename ⇒ exactly one files[] entry.

## 8. Candidate-lock v2 schema (D-103 §9)

`candidate_lock_schema=rk16c-fullcorpus-lock-v2`; `trust_anchor_mode=producer-contract-derived-sibling-v1`; `root_directly_references_file_manifest=false`; `file_manifest_key_derivation`; `payload_membership_anchor=root satellite_inventory`; `file_manifest_admissibility_anchor`. Root-manifest identity (`root_manifest_key/etag/byte_size/sha256/stored_hash/recomputed_hash`); per-file-manifest identity (`file_manifest_key/etag/byte_size/sha256/schema_version` + `file_manifest_identity_available`); payload identity (`payload_key/filename/sha256_compressed/compressed_bytes` + uncompressed mirrors, `expected_row_count`, `payload_schema_version=null` — NOT fabricated); snapshot+exec identity (`snapshot_id/production_run_id/producer_contract_version/candidate_lock_schema/created_by_workflow_run/created_from_runner_sha/created_from_workflow_sha`). Stamped by `runPreflight`: `status=UNRATIFIED`, `founder_approved=false`, `authorized_for_payload_read=false`. NO credentials, NO payload bytes. The lock NEVER claims direct cryptographic root linkage (asserted by test).

## 9. Caps (D-103 §9)

`MAX_OBJECTS=2` (metadata); `MAX_REQUESTS=8`; `MAX_ROOT_MANIFEST_BYTES=2 MiB`; `MAX_FILE_MANIFEST_BYTES=2 MiB`; `MAX_METADATA_TOTAL_BYTES=4 MiB`. Cap breach FAILS CLOSED before candidate creation (HEAD caps before each GET; combined cap after the two GETs). Defensible: the seal + per-file manifest are a few KiB each in production; 2 MiB/object is bounded, far from unlimited.

## 10. Fail-closed matrix (validated by tests)

root seal invalid JSON / not object; snapshot_id mismatch; object_prefix mismatch; missing layout/schema; manifest_hash absent/invalid; **manifest_hash stored≠recomputed**; satellite_inventory absent; payload absent from satellite_inventory; payload duplicated; derived sibling key ≠ expected (BEFORE 2nd read); root/per-file/combined byte cap exceeded; per-file manifest invalid JSON / not object / no files[]; per-file snapshot_id/object_prefix mismatch; files[] non-object entry; files[] filename escapes prefix / not bare; duplicate files[] filename; normalized satellite filename collision; root satellite missing from files[] (unreconcilable projection); projection size mismatch; target missing from projection; target sha256_compressed invalid; target compressed_bytes invalid; target records invalid; List/payload HEAD/payload GET/3rd-key (guard); lock incomplete/unauthorized (full run, fail-before-network). No degraded/partial candidate is written.

## 11. Runner reachability matrix (unchanged + tested)

no flags → dry-run/zero net; `--preflight` w/o `--execute` → plan/zero net; `--preflight --execute` (exact `--manifest-key`==seal key) → two-manifest metadata-only; `--execute` w/o `--preflight` → refused before client; generic `--execute`/`--lock`/`--full-run` → CLI-unreachable. `executeFullRun` symbol NOT imported by the runner (static test). No payload exec flag.

## 12. Test + CES results

- `tests/rk16` full suite: **115 passed** (incl. corpus-grounded, present locally). New/updated: `rk16c-two-manifest` (21), `-fullcorpus-runner` (14), `-fullcorpus-adapter` (20), `-workflow-sim` (3) — **60** directly on this change. ALL FAKE-client; **zero production R2 access**.
- CES (`python scripts/check_compliance.py`): **PASSED** (Art 5.1 ≤250 lines satisfied).
- CI on push: pending (test workflow runs automatically on the PR branch; NOT a dispatch).

## 13. Boundary attestation

Production R2 access = 0. New workflow dispatches = 0. Workflow reruns = 0. Payload HEAD/GET = 0. Production writes = 0. PR #272 remains OPEN. Old tag `rk16c-manifest-preflight-7ef1c35` unchanged. Environment `rk16c-manifest-preflight` unchanged. Old run `27556302525` not rerun. New carrier/tag = NOT created (proposed only — see §14). Working tree: only the listed files changed.

## 14. Proposed (NOT executed under this gate) — for the next RUN gate

After founder audit of this build, PM proposes (each needs separate authorization):
new audited runner SHA `7e4fa65…`; new workflow-definition SHA (the PR head with
the repin); a new byte-identical carrier PR + new exact temporary tag + env tag
policy for an eventual one-shot run; and the registered **P-12 future producer
hardening** (future root seals to directly commit `manifest.json` key + SHA-256).

## 15. NUL status

D-102 / D-103 / RK-16 governance artifacts: NUL=0.
Known pre-existing repository encoding artifact remains: `tests/tools/snomed-rehydrate.test.ts`.
