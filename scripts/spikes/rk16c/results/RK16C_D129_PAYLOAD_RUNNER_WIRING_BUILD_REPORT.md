# RK-16C D-129 Payload-Runner Wiring - BUILD REPORT (build-only; DO NOT MERGE until D-130)

Status: BUILD-ONLY. No production R2 request occurred. No payload was read. All
tests use FAKE clients (zero network). This PR only ADDS the wiring + tests so the
full-corpus payload runner CAN be run later behind a SEPARATE founder gate (D-134).

Built from `origin/main` (c917631) and this spec. The voided draft branch e2f2667
was NOT searched for, fetched, cherry-picked, or diffed against.

## What was wired

The full-corpus PAYLOAD runner is now CLI-reachable ONLY through an explicit
ratified-lock path, behind fail-before-network validation:

- New CLI action `full-run` in `preflight-control.mjs > selectAction`, reachable
  ONLY when BOTH `--full-run` AND `--lock <path>` are given. Every other path keeps
  the prior posture: generic `--execute` (and `--execute --lock` without
  `--full-run`) stays `execute-refused`; `--full-run` without `--lock` is
  `fail-closed`.
- `run-fullcorpus.mjs` dispatches `full-run` to `runFullRun(args)`
  (`preflight-control.mjs`), which builds REAL deps LAZILY and LAZILY imports the
  gated executor -- exactly mirroring how `runPreflight` is wired. The dry-run /
  preflight / fixture paths never load the gated executor. The runner source
  contains NO `executeFullRun` symbol (static guard still passes).

## Fail-before-network gate (bound constants)

`executeFullRunGated` (`lib/fullcorpus-run-gate.mjs`) throws BEFORE any client unless
ALL bind (constants in `RATIFIED_PINS` + `RATIFIED_LOCK_FILE_SHA256`):

- lock file present at `--lock`; lock file sha256 == `e6383dfe...c909bd`
- `candidate_lock_schema` == `rk16c-fullcorpus-lock-v2`
- EXPLICIT payload-read grant: `--authorized-for-payload-read` flag OR
  `RK16C_D134_PAYLOAD_READ_AUTHORIZED=1`. The artifact's OWN
  `authorized_for_payload_read` is NEVER trusted (a `true` value does NOT authorize).
- `snapshot_id` == `2026-06-14/27502029137-1`
- `payload_key` == `snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz`
- `payload_sha256_compressed` == `4fe46a75...203f`
- `payload_sha256_uncompressed` == `652d1b28...5d38`
- `expected_row_count` == `475112`
- `trust_anchor_mode` == `producer-contract-derived-sibling-v1`;
  `root_directly_references_file_manifest` == false;
  `payload_membership_authority` == `required_satellite_ssot`;
  `payload_pin_authority` == `sibling_manifest_files`
- latest.json / R2 List / fallback-discovery are NEVER required (keys are the exact
  deterministic derivations only).

## Read discipline (after the gate)

1. Disk free-space preflight (fail-before-network) + process memory monitor start.
2. Exact allowlist = root seal key + sibling manifest key + payload key ONLY
   (`fullRunAllowlist`); payload allowlisted ONLY on this path, never on preflight.
3. `reconcileMetadata` reads + validates root seal + sibling manifest and reconciles
   them vs the lock (keys, snapshot identity, `root_manifest_sha256`,
   `file_manifest_sha256`) BEFORE any payload GET.
4. Payload HEAD (size vs pin) then GET; verify compressed sha256 == lock pin BEFORE
   trusting bytes; materialize the VERIFIED COMPRESSED file only.
5. `streamDecodeVerify` gunzips as a STREAM (chunk-by-chunk); verifies uncompressed
   sha256 + row count during decode. The decompressed payload is NEVER written to
   disk (`decompressed_file_written: false`).

## Envelope / output limits

The run report carries peak heapUsed/heapTotal/RSS/external/arrayBuffers, sample
count, compressed + uncompressed bytes, rows decoded, disk-preflight terms, and
explicit negative emit flags: `emitted_family_artifact/reader_package/f4_candidate/
latest_update/public_api_route/family_registration` all `false`;
`output_kind = supplemental-spike-envelope+row-count-hash+parameter-candidate`. No
activatable family artifact / reader package / F4 candidate / latest.json update /
public API route / family registration is produced.

## Future run command (D-134 gate)

    node scripts/spikes/rk16c/run-fullcorpus.mjs --full-run \
      --lock <ratified-lock.json> --authorized-for-payload-read

Optional run channel added (DISPATCH-ONLY, INERT): workflow
`.github/workflows/rk16c-fullcorpus-payload-run.yml`. It is NOT merged / tagged /
dispatched. Multiple fail-closed guards keep it inert until the founder pins the
D-130 merge SHA and confirms the D-134 gate.

## Verification

- `npx vitest run tests/rk16` -> 10 files / 112 tests PASS (26 new; no regressions).
- `python scripts/check_compliance.py` -> CES CHECK PASSED.
- Every changed file ASCII, 0 NUL, <= 250 lines.
- Payload read count = 0; dry-run zero-network; candidate-lock artifact NOT mutated;
  no family / reader / F4 / public-API drift.
