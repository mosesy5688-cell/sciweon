# RK-16C D-103 A1 TWO-MANIFEST PREFLIGHT — BUILD REPORT

> **D-104 SUCCESSOR-PR ADDENDUM is at the bottom of this file** (clean
> validation PR identities, PM-PROPOSED runner SHA, complete 5-failure ledger,
> verification taxonomy). Per D-104 §10 the runner SHA is **PM-PROPOSED**, NOT
> "Founder-audited", until the successor gate passes. The §0 SHA below is the
> PR #272 runner SHA (historical); the successor SHA is in the addendum.

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

---

# D-104 SUCCESSOR VALIDATION PR — ADDENDUM

Per founder **D-104** (HOLD / corrective validation): a CLEAN successor PR validates
the corrected D-103 A1 implementation against current `main`, **code-only, with NO
workflow file** (resolving the PR #272 conflict structurally instead of merging the
spent carrier). The workflow carrier + its two coupled tests are a separate future
artifact.

## S0. Successor identities

```
successor branch:        feat/rk16c-fullcorpus-validation
base (current main):     5b5d4f652bedc6f1dd65e62c90853f9db756bdb1
PM-PROPOSED_RUNNER_SHA:  5328d3813d9494838d42be6fcff2f2c027dba749  (impl commit)
prior PR #272 runner SHA: 7e4fa65d38e8b8b359c82070432db952b670b26f  (PM-PROPOSED, historical)
node / npm tested:       v24.14.0 / 11.9.0   (CI runs node 22)
```

Per D-104 §10 the runner SHA is **PM-PROPOSED**, not Founder-audited, until this
gate passes (targeted + post-fix full suite + required GitHub CI green).

## S1. Code transfer (byte-identical, D-104 §5)

Source = PR #272 head `eca7987` (commits `7e4fa65` runner + `d2f0ff0` workflow/report
+ `eca7987` static-test fix). Transfer = `git checkout eca7987 -- <impl files>` onto a
branch from current main. Verified blob-OID identity (source==successor):

```
two-manifest-preflight.mjs   ba010f9b9d23   IDENTICAL
r2-readonly-adapter.mjs      4dbe3e27a28e   IDENTICAL
exact-readonly-guard.mjs     7fba97266698   IDENTICAL
fullcorpus-lock.mjs          10b92c785c43   IDENTICAL
corpus-identity.mjs          94bcbefe4a92   IDENTICAL
preflight-control.mjs        ad0d3516f0f4   IDENTICAL
run-fullcorpus.mjs           306255354c64   IDENTICAL
RK16C_FULLCORPUS_LOCK.template.json 81a0780a65c6 IDENTICAL
rk16c-two-manifest.test.ts   6c3cdc675bc4   IDENTICAL
rk16c-fullcorpus-runner.test.ts de2575b1408c IDENTICAL
rk16c-fullcorpus-adapter.test.ts 21b71c48b7ed IDENTICAL
```

ALL implementation files byte-identical (no main-compatibility change required).
24 files added; **0 modified main files**. Workflow file is NOT in the diff (confirmed).

**Excluded (D-104 §4/§6):** `.github/workflows/rk16c-manifest-preflight.yml`,
`tests/rk16/rk16c-workflow-static.test.ts`, `tests/rk16/rk16c-workflow-sim.test.ts`
(workflow-coupled → future carrier PR). P-12 NOT implemented here. No DailyMed/SNOMED
edits. No unrelated main changes.

## S2. Complete 5-failure ledger (original PR #272 full-suite run)

| # | test file | test(s) | original error | classification | evidence | fixed? | rerun result | vs current main | disposition |
|---|---|---|---|---|---|---|---|---|---|
| 1 | rk16c-workflow-static.test.ts | check6 "checkout ref==AUDITED_RUNNER_SHA" + neg-assert "SHA-verify step env" (2 tests) | `expected 'b0b8246…' to be '7e4fa65…'` | **real defect** (D-103 repin moved SHA; test pinned old) | the static test hardcoded the consumed runner SHA | YES (#272 `eca7987`) | 20/20 pass post-fix | n/a (workflow-coupled) | **EXCLUDED from successor** (carrier PR); fixed on #272 |
| 2 | dailymed-adapter-incremental.test.ts | 3 × `fetchIncremental …` (timeouts) | `Test timed out in 5000ms` | **environment flake** | byte-identical to main; only fails under concurrent full-suite load | no code change | **5/5 pass ×2 isolated reruns** on successor | identical file → identical on main | non-regression flake |
| 3 | snomed-rehydrate.test.ts | (file-level, 0 tests) | `(0 test)` collection failure | **pre-existing encoding artifact** | byte-identical to main; not in successor diff; main's own CI (node 22) is green with this file | no code change | reproduces (node-24 local only) | identical to main | known pre-existing; named in NUL wording |

**Sum: 5 failed TESTS (2+3+0) across 3 FILES** = original `5 failed | 3 files`. ✓
No failure disappears through aggregation.

## S3. Post-fix full-suite result (successor, D-104 §7.2)

```
command:   npx vitest run
commit:    5328d3813d9494838d42be6fcff2f2c027dba749
node/npm:  v24.14.0 / 11.9.0
Test Files 1 failed | 218 passed | 1 skipped (220)
Tests      2426 passed | 0 failed | 1 skipped (2427)
duration   124.29s
```

**0 test failures.** The single failed FILE is `tests/tools/snomed-rehydrate.test.ts`
("0 test" collection-level) — the known pre-existing encoding artifact (ledger #3),
byte-identical to main, the SOLE cause of the local `exit 1` (node-24 quirk; main's CI
on node 22 is green with this file present, proving it is not a real test failure).
The 2 PR #272 test-failure files (workflow-static, dailymed) are absent/green here.
Targeted: rk16c-two-manifest (21) + -runner (14) + -adapter (20) = 55 pass; CES PASS.

## S4. Verification taxonomy (D-104 §9)

- **CODE-GROUNDED:** object_prefix + manifest.json key derivation; manifest.json NOT
  root-inventory-listed; payload listed exactly once; create-only co-publication
  order; files[] satellite-projection rule. (file:line cited in §2-§7 above.)
- **FIXTURE-VERIFIED:** two-manifest Stage1/Stage2 validation, recomputed
  manifest_hash, set/target reconciliation, lock v2, guard (FAKE-client tests).
- **CI-VERIFIED:** pending real GitHub required checks on the successor PR (this gate).
- **NOT-YET-PRODUCTION-VERIFIED:** the two-manifest preflight against the real R2
  snapshot — remains closed until a separately authorized metadata RUN gate.

## S5. D-104 boundary attestation

Production R2 access = 0 · new workflow dispatches = 0 · payload reads = 0 · production
writes = 0. Old run `27556302525` / tag `rk16c-manifest-preflight-7ef1c35` /
environment UNCHANGED. PR #272 OPEN / CONFLICTING / unmodified after the D-104 ruling.
No workflow carrier created. No main merged into #272.

```
D-104 / RK-16 governance artifacts: NUL=0.

Known pre-existing repository encoding artifact remains:
tests/tools/snomed-rehydrate.test.ts
```
