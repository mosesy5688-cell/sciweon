/**
 * Stage-3 SID stamping cascade + post-stamp UMLS phases (extracted from
 * stage-3-aggregate.js for Art 5.1 250-line cap, PR-UMLS-3).
 *
 * SID stamping cascade (HARD-FAIL on any failure per V1.0 Sec 35 +
 * [[cross_cycle_silent_data_loss]]): 7 Layer-1 atomic classes + 1 Layer-3 assertion
 * class + 1 NegEvidence + the 2 UMLS vocabulary classes (mesh_concept, snomed_concept).
 * Each new class auto-provisions its counter bucket + crosswalk on first stamp.
 *
 * Post-stamp UMLS phases (also HARD-FAIL), in order:
 *   1. snomed-public-builder   -- project the FULL stamped snomed-concepts.jsonl down to
 *      the Born-Clean public {sid_s,sid_c} artifact (RULING 1). MUST run after the SNOMED
 *      stamper (every concept carries sid_s+sid_c) and before the F4 upload.
 *   2. mesh-crosslink-enricher  -- F2 paper<->mesh_concept (idempotent paper.mesh_links).
 *   3. snomed-crosslink-enricher-- F2 disease+trial<->snomed_concept (idempotent
 *      snomed_links; ALL links published incl low-confidence; {snomed_sid,confidence,
 *      match_method} only -- ZERO NLM/SNOMED content).
 *
 * COLD-START GUARD (PR-UMLS-3): runSidStampingCascade honors a skipSnomed flag that excludes
 * the 3 SNOMED entries (see SNOMED_CASCADE_SCRIPTS) when the SNOMED bulk cursor is absent.
 */

import { SNOMED_CASCADE_SCRIPTS } from './snomed-cold-start.js';

// SID stamping cascade order. Each entry = [label, script]. Order is load-bearing
// (the cross-link enrichers below assume the concept files are stamped).
export const SID_STAMPERS = Object.freeze([
    ['1.1c compound', 'stage-3-sid-stamp.js'],
    ['1.2 trial', 'stage-3-trial-sid-stamp.js'],
    ['1.3 paper', 'stage-3-paper-sid-stamp.js'],
    ['1.4 target', 'stage-3-target-sid-stamp.js'],
    ['1.5 bioactivity', 'stage-3-bioactivity-sid-stamp.js'],
    ['1.6b disease', 'stage-3-disease-sid-stamp.js'],
    ['1.6a SAL', 'stage-3-sal-sid-stamp.js'],
    ['1.7 NegEvidence', 'stage-3-negevidence-sid-stamp.js'],
    // PR-UMLS-2: mesh_concept stamper (9th hard-fail entry; first stamp auto-provisions).
    ['1.8 mesh', 'stage-3-mesh-sid-stamp.js'],
    // PR-UMLS-3: snomed_concept stamper (10th hard-fail entry; first stamp auto-provisions).
    // Runs on the FULL internal snomed-concepts.jsonl; the sid_s/sid_c it writes are the ONLY
    // SNOMED-derived values that reach the public snapshot (RULING 1).
    ['1.9 snomed', 'stage-3-snomed-sid-stamp.js'],
]);

// Post-stamp UMLS phases (HARD-FAIL), run in array order AFTER the stamping cascade.
export const POST_STAMP_UMLS_PHASES = Object.freeze([
    ['PR-UMLS-3 SNOMED public projection (Born-Clean {sid_s,sid_c})', 'snomed-public-builder.js'],
    ['PR-UMLS-2 MeSH cross-link enricher', 'mesh-crosslink-enricher.js'],
    ['PR-UMLS-3 SNOMED cross-link enricher (ALL links + provenance)', 'snomed-crosslink-enricher.js'],
]);

/**
 * Run the SID stamping cascade then the post-stamp UMLS phases, all HARD-FAIL.
 *
 * PR-UMLS-3 cold-start guard (Invariant 1): when `skipSnomed` is true (the SNOMED bulk
 * cursor does NOT yet exist in R2), the 3 SNOMED cascade entries (the `1.9 snomed` stamper
 * + the snomed-public-builder + the snomed-crosslink-enricher) are EXCLUDED so the daily
 * cascade + snapshot still complete WITHOUT SNOMED this cycle. The 9 non-SNOMED stampers +
 * the MeSH cross-link enricher run UNCONDITIONALLY. When `skipSnomed` is false (cursor
 * exists), every entry runs and a broken downstream artifact HARD-FAILS in place (Invariant
 * 2) -- the guard is purely additive and never weakens that throw.
 *
 * @param {(name:string)=>Promise<void>} runScript  the orchestrator's spawn-node helper.
 * @param {{skipSnomed?: boolean}} [opts]
 */
export async function runSidStampingCascade(runScript, opts = {}) {
    const skipSnomed = opts.skipSnomed === true;
    const skip = (script) => skipSnomed && SNOMED_CASCADE_SCRIPTS.includes(script);
    for (const [label, script] of SID_STAMPERS) {
        if (skip(script)) { console.log(`\n[STAGE-3] === PR-SID-${label} stamping SKIPPED (SNOMED cold start) ===`); continue; }
        console.log(`\n[STAGE-3] === PR-SID-${label} stamping ===`);
        await runScript(script);
    }
    for (const [label, script] of POST_STAMP_UMLS_PHASES) {
        if (skip(script)) { console.log(`\n[STAGE-3] === ${label} SKIPPED (SNOMED cold start) ===`); continue; }
        console.log(`\n[STAGE-3] === ${label} ===`);
        await runScript(script);
    }
}
