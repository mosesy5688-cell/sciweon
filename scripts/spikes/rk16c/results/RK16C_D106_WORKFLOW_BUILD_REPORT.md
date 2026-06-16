# RK-16C D-106 CORRECTED TWO-MANIFEST WORKFLOW — BUILD REPORT

**BUILD-ONLY. NO workflow merge. NO workflow dispatch. NO environment approval. NO
production R2 access / metadata HEAD/GET. NO payload access. NO new tag. NO env-policy
change. NO old-workflow modification. NO runner/adapter/guard/lock/producer change.**

A NEW dedicated workflow surface for the corrected D-103 A1 two-manifest preflight,
pinning the final audited runner. It is NOT a revision of the spent
`rk16c-manifest-preflight.yml`.

## §18 BUILD report items

1. **BUILD PR:** (opened against main; number in the chat report)
2. **Branch:** `feat/rk16c-two-manifest-workflow`
3. **Base main SHA:** `47b2672770708725b42f1b558391fc077a472848`
4. **PR head SHA:** the single BUILD commit on this branch (`git rev-parse HEAD`; reported in chat)
5. **Changed-file list (4):**
   - `.github/workflows/rk16c-two-manifest-preflight.yml` (NEW)
   - `tests/rk16/rk16c-two-manifest-workflow-static.test.ts` (NEW)
   - `tests/rk16/rk16c-two-manifest-workflow-sim.test.ts` (NEW)
   - `scripts/spikes/rk16c/results/RK16C_D106_WORKFLOW_BUILD_REPORT.md` (this report)
6. **Old workflow unmodified:** `rk16c-manifest-preflight.yml` — **no diff vs main** (verified).
7. **New workflow content:** `.github/workflows/rk16c-two-manifest-preflight.yml` (full file on the PR).
8. **Workflow name / path:** `RK-16C Two-Manifest Preflight` / `.github/workflows/rk16c-two-manifest-preflight.yml`.
9. **Trigger:** `workflow_dispatch:` only.
10. **Inputs = none:** no `inputs:` key (asserted by static test).
11. **Permissions:** `contents: read` (only).
12. **Environment:** `rk16c-manifest-preflight` (the human approval boundary; unchanged; its tag policy is a later gate).
13. **Action pins (immutable full SHA):** checkout `34e114876b0b11c390a56381ad16ebd13914f8d5`; setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020`; upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02` (the previously verified pins; no SHA changed).
14. **Audited runner checkout SHA:** `47b2672770708725b42f1b558391fc077a472848`.
15. **SHA-verification step:** `git rev-parse HEAD` compared to `AUDITED_RUNNER_SHA`, `exit 1` on mismatch, BEFORE creds/R2 client; no `if:` bypass.
16. **Exact execution command:** `node scripts/spikes/rk16c/run-fullcorpus.mjs --preflight --execute --snapshot 2026-06-14/27502029137-1 --manifest-key snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json`.
17. **Exact snapshot:** `2026-06-14/27502029137-1`.
18. **Exact root-manifest key:** `snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json`.
19. **Expected derived sibling key (runner-internal, NOT a CLI/input):** `snapshots/2026-06-14/27502029137-1/manifest.json` (= validated object_prefix + `manifest.json`).
20. **Concurrency:** group `rk16c-two-manifest-preflight` (distinct, static), `cancel-in-progress: false`.
21. **Event guard:** step 1, `if: github.event_name != 'workflow_dispatch'` → `exit 1` (before checkout).
22. **Run-attempt guard:** `if: github.run_attempt != '1'` → `exit 1` (before checkout). NOTE: a new manual dispatch still has `run_attempt=1`; one-shot semantics still depend on founder auth + env approval + the exact-tag policy (later gate) — the YAML alone does NOT enforce global single-use.
23. **Secret names + scopes only (values NOT read/exposed):** `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — the existing general repository R2 secrets (same as `p8-r1-readonly-probe.yml`); referenced via `env:`, NOT `secrets: inherit`.
24. **Artifact name + retention:** `rk16c-two-manifest-candidate-lock-UNRATIFIED`; path = `scripts/spikes/rk16c/results/RK16C_FULLCORPUS_LOCK.candidate.json` only; `retention-days: 14`; `if-no-files-found: warn`.
25. **Candidate-lock v2 assertions:** the workflow documents candidate-lock schema v2, UNRATIFIED, NOT AUTHORIZED FOR PAYLOAD READ, `root_directly_references_file_manifest=false`, `trust_anchor_mode=producer-contract-derived-sibling-v1` (runner emits these; the workflow never fabricates a lock).
26. **Static/security test:** `tests/rk16/rk16c-two-manifest-workflow-static.test.ts` — **PASS** (D-106 checks 1-21 + negatives).
27. **Fake simulation:** `tests/rk16/rk16c-two-manifest-workflow-sim.test.ts` — **PASS** (checks 22-25: 2 exact metadata reads; 3rd key rejected; payload HEAD/GET rejected; zero production network).
28. **Existing RK-16 tests:** rk16c-two-manifest (21) + -fullcorpus-runner (14) + -fullcorpus-adapter (20) green locally; full `tests/rk16` green on main (#274). (CI re-runs the suite.)
29. **CES:** PASS.
30. **GitHub CI:** required checks on the BUILD PR (CI/test, CI/security-scan, CI/schema-validate, CES Gatekeeper) — reported in chat once green.
31. **Production R2 access:** 0.
32. **Manual workflow dispatches:** 0.
33. **Metadata requests:** 0.
34. **Payload requests:** 0.
35. **Production writes:** 0.
36. **Old run/tag/environment unchanged:** run `27556302525`, tag `rk16c-manifest-preflight-7ef1c35`, env `rk16c-manifest-preflight`, old carrier `rk16c-manifest-preflight.yml` — all untouched.
37. **PR remains OPEN:** yes (no merge; no carrier; no tag; no env change; no dispatch).
38. **Working tree:** clean after commit (only the 4 listed files added).
39. **NUL:**

```
D-106 / RK-16 governance artifacts: NUL=0.

Known pre-existing repository encoding artifact remains:
tests/tools/snomed-rehydrate.test.ts
```

## Gate boundary (D-106 §20)
Authorized: this workflow-definition BUILD PR + static/security tests + fake simulation +
ordinary PR CI + PM first-line audit + governance update. NOT authorized: workflow merge,
replacement carrier, old-workflow modification/deletion, new/old tag ops, env-policy
change, dispatch, env approval, production metadata read, payload access, P-12, family.

Submit for founder workflow **security audit**. No carrier / tag / env-policy until that audit passes.
