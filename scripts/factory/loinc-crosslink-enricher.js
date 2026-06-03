/**
 * LOINC Cross-link Enricher -- PR-UMLS-4b F2 orchestrator (trial <-> loinc_concept).
 *
 * Runs AFTER the SID stamping loop + the LOINC public builder (so loinc-concepts.jsonl carries
 * sid_s). Loads output/linked/trials.jsonl + the FULL stamped (internal working copy)
 * output/linked/loinc-concepts.jsonl, attaches trial.loinc_links via
 * lib/loinc-crosslink-helpers.js (deterministic Token-Set Jaccard), and rewrites trials.jsonl
 * in place.
 *
 * ANCHOR (founder-locked): trial.results.primary_outcomes[].title (the lab/outcome MEASURE
 * axis). NOT trial.conditions (the DISEASE axis = SNOMED territory = category error). Secondary
 * outcomes are out of scope (schema stores only secondary_outcomes_count -- no titles to match).
 *
 * COMPLIANCE (RULING 1 + cross-link policy): each public link is EXACTLY
 * { loinc_sid, confidence, match_method } (no cui/code/str -- 100% Sciweon provenance; the
 * researcher recovers code/str by joining loinc_sid into loinc-concepts-public.jsonl). ALL links
 * are published, high AND low confidence -- low-confidence Jaccard links are NOT withheld (the
 * consumer filters; the ONLY floor is Jaccard > 0). The token index is built from the FULL
 * internal concepts (STR/synonyms), but those proprietary values NEVER enter a link.
 *
 * DECISION: idempotent OVERWRITE of trial.loinc_links; sid_s/sid_c untouched. Fail-soft
 * per-outcome + loud bucketed telemetry (no silent drop). Heavy logic lives in
 * lib/loinc-crosslink-helpers.js (pure, unit-tested); this orchestrator owns IO.
 *
 * Non-throwing on an absent loinc-concepts.jsonl is NOT permitted: this enricher is wired
 * immediately after the LOINC stamper + public builder, so the stamped concept file MUST exist.
 * A missing/empty concept file would silently zero every trial's loinc_links -> HALT loud
 * (mirrors snomed-crosslink-enricher.js HALT-on-zero).
 */

import fs from 'fs/promises';
import path from 'path';
import { enrichTrialsWithLoincLinks, assertLoincConceptsLoaded, assertTrialsLoaded } from './lib/loinc-crosslink-helpers.js';
// PR-HARDEN-1: the PR-4b ENOENT-only loadJsonl fix now lives in the shared lib/jsonl-io.js
// (loadJsonlStrict) so the single implementation is reused across every enricher. skipComments:true
// preserves the original PR-4b '#'-comment filter byte-identically. The HALT guards stay the
// loinc-helper assertTrialsLoaded / assertLoincConceptsLoaded (so the loinc tests stay green).
import { loadJsonlStrict } from './lib/jsonl-io.js';

const OUTPUT_DIR = './output/linked';
const LABEL = 'LOINC-XLINK';

async function writeJsonl(file, records) {
    // join() is stack-safe at any size (Defect-15 lesson).
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''));
}

async function main() {
    console.log(`[${LABEL}] PR-UMLS-4b F2 trial <-> loinc_concept cross-link (deterministic Token-Set Jaccard)`);

    const trialsPath = path.join(OUTPUT_DIR, 'trials.jsonl');
    const loincPath = path.join(OUTPUT_DIR, 'loinc-concepts.jsonl');
    const trials = await loadJsonlStrict(trialsPath, { skipComments: true });
    const concepts = await loadJsonlStrict(loincPath, { skipComments: true });
    console.log(`[${LABEL}] Loaded ${trials.length} trials, ${concepts.length} stamped LOINC concepts`);

    // HALT loud (FIX 2): trials are produced before the UMLS cascade, so 0 trials is an anomaly --
    // refuse to overwrite trials.jsonl with empty content (belt-and-suspenders to loadJsonl's
    // ENOENT-only swallow). Then HALT on 0 concepts (no silent zero-out). Both are shared,
    // unit-tested guards; both run BEFORE writeJsonl so nothing can truncate trials.jsonl.
    assertTrialsLoaded(trials, LABEL);
    assertLoincConceptsLoaded(concepts, LABEL);

    const telemetry = enrichTrialsWithLoincLinks(trials, concepts);

    await writeJsonl(trialsPath, trials);

    const trialsWithLinks = trials.filter(t => Array.isArray(t.loinc_links) && t.loinc_links.length > 0).length;
    console.log(`[${LABEL}] === TELEMETRY ===`);
    console.log(`  trials_processed:          ${telemetry.trials_processed}`);
    console.log(`  terms_total:               ${telemetry.terms_total}`);
    console.log(`  jaccard_hits:              ${telemetry.jaccard_hits}`);
    console.log(`  no_match:                  ${telemetry.no_match}`);
    console.log(`  by_token_index_size:       ${telemetry.by_token_index_size}`);
    console.log(`  concepts_missing_sid:      ${telemetry.concepts_missing_sid}`);
    console.log(`  concepts_empty_tokenset:   ${telemetry.concepts_empty_tokenset}`);
    console.log(`  trials_with_loinc_links:   ${trialsWithLinks}/${trials.length}`);
    if (telemetry.no_match_samples.length > 0) {
        console.log(`  no_match_samples:          ${JSON.stringify(telemetry.no_match_samples)}`);
    }
    console.log(`[${LABEL}] SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
