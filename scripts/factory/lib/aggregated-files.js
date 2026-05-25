/**
 * AGGREGATED_FILES — single source-of-truth for the aggregated bundle.
 *
 * Three SSoT lists for three publishing boundaries:
 *
 *   ENRICHED_FILES   stage-2-process → R2 processed/enriched/<run_id>/
 *   AGGREGATED_FILES stage-3-aggregate → R2 processed/aggregated/<run_id>/
 *                    stage-4-upload   ← downloads same prefix
 *   SNAPSHOT_FILES   snapshot-builder → snapshots/<date>/
 *
 * Before SSoT extraction, the lists lived hard-coded in each script and
 * drifted: PR #96 added target-index.json to stage-3 only and F4 silently
 * skipped publishing it; PR #98 fixed that drift. Cycle 21 follow-up
 * (2026-05-23): PR #103 added adapter-cross-linker drug-labels.jsonl
 * emission in stage-2, but stage-2-process.js's hard-coded
 * `['compounds-enriched.jsonl', 'bioactivities.jsonl']` upload list was
 * never updated, silently dropping drug-labels.jsonl from R2 every cron.
 * This new `ENRICHED_FILES` export closes that gap — stage-2 now imports
 * from here, same SSoT pattern as stage-3/4.
 *
 * Adding a new bundled artifact now means editing one place (the right
 * list for the producer stage) — not three.
 *
 * The frozen arrays prevent accidental mutation at module scope.
 */

/**
 * stage-2-process outputs. Adapter pipeline emits these to ./output/linked/
 * and uploadStage('enriched', runId, ENRICHED_FILES) publishes them.
 *
 * - compounds-enriched.jsonl  — cross-source compound enrichment (in-place)
 * - bioactivities.jsonl       — cross-validated activities
 * - drug-labels.jsonl         — DailyMed DrugLabel entities (PR #103,
 *                               emitted by adapter-cross-linker; may be
 *                               an empty file on cycles with no DailyMed
 *                               link). uploadStage's missing-file check
 *                               accepts empty files; only ENOENT throws.
 */
export const ENRICHED_FILES = Object.freeze([
    'compounds-enriched.jsonl',
    'bioactivities.jsonl',
    'drug-labels.jsonl',
]);

/**
 * stage-3-aggregate outputs (superset of ENRICHED_FILES — passes the
 * stage-2 artifacts through unchanged AND adds the stage-3-derived files:
 * trial+paper linkages, neg-evidence builder output, FTS5 search index,
 * target inverse-pivot index).
 *
 * Stage-3 ingests ENRICHED_FILES from R2 processed/enriched/<f2_run_id>/,
 * runs trial-linker / paper-linker / bidirectional-linker / neg-evidence-
 * builder / search-index-builder / target-index-builder, then uploads
 * AGGREGATED_FILES to R2 processed/aggregated/<f3_run_id>/.
 */
export const AGGREGATED_FILES = Object.freeze([
    ...ENRICHED_FILES,
    'trials.jsonl',
    'trial-links.jsonl',
    'papers.jsonl',
    'paper-links.jsonl',
    // Phase 1.4-pre.1b: targets.jsonl produced by scripts/factory/target-linker.js
    // (OT target.jsonl.zst + bioactivity.target merged, ~19K entries). Required
    // by Phase 1.4 SID stamping consumer; snapshot publication ensures
    // researchers receive stamped target entities in daily bundle.
    'targets.jsonl',
    // Phase 1.6a: sal-assertions.jsonl produced by scripts/factory/stage-3-sal-sid-stamp.js
    // (content-addressed UUID v5 anchored assertions; bioactivity-as-assertion in
    // PR 1.6a, OT clinical_indication additively appended in PR 1.6c).
    'sal-assertions.jsonl',
    'negative-evidence-raw.jsonl',
    'neg-evidence.jsonl',
    'sciweon-search-index.json',
    'target-index.json',
]);

/**
 * SNAPSHOT_FILES — what snapshot-builder.js bundles into snapshots/<date>/.
 *
 * Currently equal to AGGREGATED_FILES (drug-labels.jsonl now flows
 * through the aggregated bundle as of 2026-05-23, no longer a separate
 * out-of-band file). Kept as a distinct export so snapshot-builder doesn't
 * need to know about the stage-3 boundary; if future snapshot-only
 * artifacts emerge (e.g. derived analytics) they can be appended here
 * without affecting upstream stages.
 */
export const SNAPSHOT_FILES = Object.freeze([...AGGREGATED_FILES]);
