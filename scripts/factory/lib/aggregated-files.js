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
    // Phase 1.6b-pre.1b: diseases.jsonl produced by scripts/factory/disease-linker.js
    // (~47K OT disease records normalized into Sciweon per-namespace multi-canon
    // shape: oba / mondo / efo / hp / orphanet + unclassified_ontology tail-fuse).
    // Required by Phase 1.6b SID disease stamper + downstream PR 1.6c
    // clinical_indication SAL stamping (object-side disease.sid_s lookup).
    'diseases.jsonl',
    // PR-UMLS-2: mesh-concepts.jsonl produced by scripts/factory/mesh-concept-linker.js
    // (F3 placement of the ~355K MSH concept corpus from R2) and stamped in place by
    // stage-3-mesh-sid-stamp.js (mesh_concept class). This is the FULL (code + cui +
    // preferred_str + sid_s + sid_c) INTERNAL working copy: it is in AGGREGATED_FILES ONLY
    // (internal F3->F4 round-trip so the F2 mesh-crosslink-enricher has the full code/cui/
    // string indices). PR-UMLS-2a: it is DELIBERATELY OMITTED from SNAPSHOT_FILES because
    // its `cui` is a UMLS-Metathesaurus-proprietary identifier whose public redistribution
    // the license forbids (the prior breach). See the SNAPSHOT_FILES divergence note below.
    'mesh-concepts.jsonl',
    // PR-UMLS-2a COMPLIANCE REMEDIATION: mesh-concepts-public.jsonl is the public projection
    // of the MeSH corpus -- EXACTLY {sid_s, sid_c, code, str} per concept (mesh-public-
    // builder.js via projectUmlsPublic('MESH', ...); cui DROPPED, Cat-0 code+str KEPT). This
    // is the ONLY MeSH-derived file permitted into the public snapshot (it is in BOTH lists).
    'mesh-concepts-public.jsonl',
    // PR-UMLS-3: snomed-concepts.jsonl is the FULL (STR + raw CODE + CUI + sid_s + sid_c)
    // INTERNAL working copy -- snomed-concept-linker.js places it, stage-3-snomed-sid-stamp.js
    // stamps it, the cross-link enricher reads it. It is in AGGREGATED_FILES ONLY so it
    // round-trips F3->F4 via the aggregated prefix (the cross-link enricher in F3 needs the
    // full STR/CODE/CUI to build byCode/byCui/byString). It is DELIBERATELY ABSENT from
    // SNAPSHOT_FILES (RULING 1: no SNOMED proprietary content in the public snapshot --
    // SNOMED CT Affiliate redistribution). See the SNAPSHOT_FILES divergence note below.
    'snomed-concepts.jsonl',
    // PR-UMLS-3 COMPLIANCE CORE: snomed-concepts-public.jsonl is the "Born-Clean" public
    // projection -- EXACTLY {sid_s, sid_c} per concept (snomed-public-builder.js via the
    // projectSnomedPublic allowlist; CUI annihilated, no STR/CODE). This is the ONLY
    // SNOMED-derived file permitted into the public snapshot (it is in BOTH lists).
    'snomed-concepts-public.jsonl',
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
 * SNAPSHOT_FILES — what snapshot-builder.js bundles into the PUBLIC snapshots/<date>/.
 *
 * ============================ DIVERGENCE FROM AGGREGATED_FILES ============================
 * Until PR-UMLS-3, SNAPSHOT_FILES === AGGREGATED_FILES verbatim. PR-UMLS-3 made this an
 * EXPLICIT ALLOWLIST that omitted the FULL `snomed-concepts.jsonl`. PR-UMLS-2a EXTENDS the
 * divergence: BOTH full UMLS concept files are now SNAPSHOT-omitted for CUI/license reasons,
 * while their cui-free public projections are KEPT:
 *
 *   OMITTED:  snomed-concepts.jsonl  (FULL: STR + raw CODE + CUI)
 *             mesh-concepts.jsonl    (FULL: code + CUI + preferred_str)
 *   KEPT:     snomed-concepts-public.jsonl  (Born-Clean {sid_s,sid_c})
 *             mesh-concepts-public.jsonl    (Cat-0 {sid_s,sid_c,code,str}; cui DROPPED)
 *
 * WHY (founder NON-NEGOTIABLE -- the most compliance-critical line in the repo): the CUI is an
 * NLM-proprietary UMLS Metathesaurus structural identifier whose public redistribution the
 * UMLS License FORBIDS (universal -- it applies to MeSH as well as SNOMED). The public snapshot
 * is served to NON-licensee researchers. SNOMED is ADDITIONALLY Affiliate-restricted on its STR
 * + raw CODE (so its public projection is Sciweon SID hashes ONLY); MeSH code+str are Cat-0 /
 * NLM-public-domain and are KEPT. The PR-UMLS-2a breach: mesh-concepts.jsonl (355,249 records)
 * shipped into the public snapshot WITH cui -> an active redistribution breach. The fix moves
 * the full file to AGGREGATED-only and publishes only the cui-free mesh-concepts-public.jsonl.
 * If a future change re-unifies these lists (`[...AGGREGATED_FILES]`), it would silently
 * republish BOTH proprietary payloads -- the aggregated-files-ssot test pins both omissions so
 * any such re-unify is caught in CI.
 *
 * This is an EXPLICIT, per-file allowlist (NOT a spread of AGGREGATED_FILES) precisely so the
 * two omissions are intentional, visible, and reviewable rather than an accidental inclusion.
 * ===============================================================================================
 */
export const SNAPSHOT_FILES = Object.freeze(
    AGGREGATED_FILES.filter(f => f !== 'snomed-concepts.jsonl' && f !== 'mesh-concepts.jsonl'),
);
