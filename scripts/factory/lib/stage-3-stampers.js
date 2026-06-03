/**
 * Stage-3 SID stamping cascade + post-stamp UMLS phases (extracted from
 * stage-3-aggregate.js for Art 5.1 250-line cap, PR-UMLS-3).
 *
 * SID stamping cascade (HARD-FAIL on any failure per V1.0 Sec 35 +
 * [[cross_cycle_silent_data_loss]]): 7 Layer-1 atomic classes + 1 Layer-3 assertion
 * class + 1 NegEvidence + the 3 UMLS vocabulary classes (mesh_concept, snomed_concept,
 * loinc_concept). Each new class auto-provisions its counter bucket + crosswalk on first stamp.
 *
 * Post-stamp UMLS phases (also HARD-FAIL), in order:
 *   1. mesh-public-builder      -- PR-UMLS-2a: project the FULL stamped mesh-concepts.jsonl
 *      down to the public {sid_s,sid_c,code,str} artifact (CUI DROPPED -- UMLS proprietary
 *      identifier withheld). MUST run after the MeSH stamper (every concept carries
 *      sid_s+sid_c) and before the F4 upload. Remediates the CUI-in-public-snapshot breach.
 *   2. snomed-public-builder   -- project the FULL stamped snomed-concepts.jsonl down to
 *      the Born-Clean public {sid_s,sid_c} artifact (RULING 1). MUST run after the SNOMED
 *      stamper (every concept carries sid_s+sid_c) and before the F4 upload.
 *   3. loinc-public-builder    -- PR-UMLS-4: project the FULL stamped loinc-concepts.jsonl down
 *      to the Cat-0 public {sid_s,sid_c,code,str} artifact (CUI DROPPED) + verbatim Regenstrief
 *      attribution header. MUST run after the LOINC stamper. Concept-class only (no crosslink).
 *   4. mesh-crosslink-enricher  -- F2 paper<->mesh_concept (idempotent paper.mesh_links).
 *   5. snomed-crosslink-enricher-- F2 disease+trial<->snomed_concept (idempotent
 *      snomed_links; ALL links published incl low-confidence; {snomed_sid,confidence,
 *      match_method} only -- ZERO NLM/SNOMED content).
 *   6. loinc-crosslink-enricher -- PR-UMLS-4b: F2 trial<->loinc_concept (idempotent loinc_links;
 *      deterministic token_set_jaccard over primary outcome titles; ALL links published incl low
 *      confidence; {loinc_sid,confidence,match_method} only -- ZERO NLM/LOINC content).
 *
 * COLD-START GUARD: runSidStampingCascade honors a skipSnomed flag (PR-UMLS-3; excludes the 3
 * SNOMED_CASCADE_SCRIPTS entries) and a skipLoinc flag (PR-UMLS-4; excludes the 2
 * LOINC_CASCADE_SCRIPTS entries) when the respective bulk cursor is absent.
 */

import { SNOMED_CASCADE_SCRIPTS } from './snomed-cold-start.js';
import { LOINC_CASCADE_SCRIPTS } from './loinc-cold-start.js';

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
    // PR-UMLS-4: loinc_concept stamper (11th hard-fail entry; first stamp auto-provisions).
    // Runs on the FULL internal loinc-concepts.jsonl; the public projection keeps the Cat-0
    // {sid_s,sid_c,code,str} (cui DROPPED). Concept-class only; trial crosslink is PR-4b.
    ['1.10 loinc', 'stage-3-loinc-sid-stamp.js'],
]);

// Post-stamp UMLS phases (HARD-FAIL), run in array order AFTER the stamping cascade.
export const POST_STAMP_UMLS_PHASES = Object.freeze([
    ['PR-UMLS-2a MeSH public projection ({sid_s,sid_c,code,str}; cui DROPPED)', 'mesh-public-builder.js'],
    ['PR-UMLS-3 SNOMED public projection (Born-Clean {sid_s,sid_c})', 'snomed-public-builder.js'],
    ['PR-UMLS-4 LOINC public projection ({sid_s,sid_c,code,str}; cui DROPPED)', 'loinc-public-builder.js'],
    ['PR-UMLS-2 MeSH cross-link enricher', 'mesh-crosslink-enricher.js'],
    ['PR-UMLS-3 SNOMED cross-link enricher (ALL links + provenance)', 'snomed-crosslink-enricher.js'],
    ['PR-UMLS-4b LOINC cross-link enricher', 'loinc-crosslink-enricher.js'],
]);

/**
 * Run the SID stamping cascade then the post-stamp UMLS phases, all HARD-FAIL.
 *
 * Cold-start guard (Invariant 1), independent per vocabulary:
 *   - `skipSnomed` true (PR-UMLS-3): the 3 SNOMED cascade entries (the `1.9 snomed` stamper +
 *     the snomed-public-builder + the snomed-crosslink-enricher) are EXCLUDED.
 *   - `skipLoinc` true (PR-UMLS-4 + PR-4b): the 3 LOINC cascade entries (the `1.10 loinc`
 *     stamper + the loinc-public-builder + the loinc-crosslink-enricher) are EXCLUDED.
 * Excluding a vocabulary lets the daily cascade + snapshot still complete WITHOUT it this
 * cycle; every other stamper + the MeSH cross-link enricher run UNCONDITIONALLY. When a flag
 * is false (its bulk cursor exists), its entries run and a broken downstream artifact
 * HARD-FAILS in place (Invariant 2) -- the guards are purely additive and never weaken that.
 *
 * @param {(name:string)=>Promise<void>} runScript  the orchestrator's spawn-node helper.
 * @param {{skipSnomed?: boolean, skipLoinc?: boolean}} [opts]
 */
export async function runSidStampingCascade(runScript, opts = {}) {
    const skipSnomed = opts.skipSnomed === true;
    const skipLoinc = opts.skipLoinc === true;
    // Return the cold-start reason for a script, or null if it must run.
    const skipReason = (script) => {
        if (skipSnomed && SNOMED_CASCADE_SCRIPTS.includes(script)) return 'SNOMED cold start';
        if (skipLoinc && LOINC_CASCADE_SCRIPTS.includes(script)) return 'LOINC cold start';
        return null;
    };
    for (const [label, script] of SID_STAMPERS) {
        const reason = skipReason(script);
        if (reason) { console.log(`\n[STAGE-3] === PR-SID-${label} stamping SKIPPED (${reason}) ===`); continue; }
        console.log(`\n[STAGE-3] === PR-SID-${label} stamping ===`);
        await runScript(script);
    }
    for (const [label, script] of POST_STAMP_UMLS_PHASES) {
        const reason = skipReason(script);
        if (reason) { console.log(`\n[STAGE-3] === ${label} SKIPPED (${reason}) ===`); continue; }
        console.log(`\n[STAGE-3] === ${label} ===`);
        await runScript(script);
    }
}
