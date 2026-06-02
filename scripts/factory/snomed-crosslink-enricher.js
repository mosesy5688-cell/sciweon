/**
 * SNOMED Cross-link Enricher -- PR-UMLS-3 F2 orchestrator
 * (disease <-> snomed_concept  +  trial <-> snomed_concept).
 *
 * Runs AFTER the SID stamping loop (so snomed-concepts.jsonl carries sid_s). Loads
 * output/linked/diseases.jsonl + output/linked/trials.jsonl + the FULL stamped
 * output/linked/snomed-concepts.jsonl (internal working copy), attaches
 * disease.snomed_links (code_join + cui_join) and trial.snomed_links (fuzzy_string_resolve)
 * via lib/snomed-crosslink-helpers.js, and rewrites diseases.jsonl + trials.jsonl in place.
 *
 * COMPLIANCE (RULING 1 + corrected CROSS-LINK POLICY): each public link is EXACTLY
 * { snomed_sid, confidence, match_method } (no cui/code/str -- 100% Sciweon provenance).
 * ALL links are published, high AND low confidence -- low-confidence string-resolve links are
 * NOT withheld (the consumer filters). The indices are built from the FULL internal concepts
 * (STR/CODE/CUI), but those proprietary values NEVER enter a link.
 *
 * DECISION: idempotent overwrite of record.snomed_links; sid_s/sid_c untouched. Fail-soft
 * per-term + loud bucketed telemetry (no silent drop). Heavy logic lives in
 * lib/snomed-crosslink-helpers.js (pure, unit-tested); this orchestrator owns IO.
 *
 * Non-throwing on an absent snomed-concepts.jsonl is NOT permitted: this enricher is wired
 * immediately after the hard-fail stamping loop, so the stamped concept file MUST exist. A
 * missing/empty concept file would silently zero every record's snomed_links -> HALT loud.
 */

import fs from 'fs/promises';
import path from 'path';
import { enrichWithSnomedLinks } from './lib/snomed-crosslink-helpers.js';

const OUTPUT_DIR = './output/linked';
const LABEL = 'SNOMED-XLINK';

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).filter(l => !l.startsWith('#')).map(l => JSON.parse(l));
    } catch { return []; }
}

async function writeJsonl(file, records) {
    // join() is stack-safe at any size (Defect-15 lesson).
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''));
}

async function main() {
    console.log(`[${LABEL}] PR-UMLS-3 F2 disease+trial <-> snomed_concept cross-link`);

    const diseasesPath = path.join(OUTPUT_DIR, 'diseases.jsonl');
    const trialsPath = path.join(OUTPUT_DIR, 'trials.jsonl');
    const snomedPath = path.join(OUTPUT_DIR, 'snomed-concepts.jsonl');
    const diseases = await loadJsonl(diseasesPath);
    const trials = await loadJsonl(trialsPath);
    const concepts = await loadJsonl(snomedPath);
    console.log(`[${LABEL}] Loaded ${diseases.length} diseases, ${trials.length} trials, ${concepts.length} stamped SNOMED concepts`);

    if (concepts.length === 0) {
        throw new Error(`[${LABEL}] HALT: 0 SNOMED concepts loaded from ${snomedPath} -- the F3 placement + stamper must run first; refusing to zero every record's snomed_links (no silent drop)`);
    }

    const telemetry = enrichWithSnomedLinks(diseases, trials, concepts);

    await writeJsonl(diseasesPath, diseases);
    await writeJsonl(trialsPath, trials);

    const diseasesWithLinks = diseases.filter(d => Array.isArray(d.snomed_links) && d.snomed_links.length > 0).length;
    const trialsWithLinks = trials.filter(t => Array.isArray(t.snomed_links) && t.snomed_links.length > 0).length;
    console.log(`[${LABEL}] === TELEMETRY ===`);
    console.log(`  diseases_processed:        ${telemetry.diseases_processed}`);
    console.log(`  trials_processed:          ${telemetry.trials_processed}`);
    console.log(`  terms_total:               ${telemetry.terms_total}`);
    console.log(`  exact_code_join_hits:      ${telemetry.exact_code_join_hits}`);
    console.log(`  cui_join_hits:             ${telemetry.cui_join_hits}`);
    console.log(`  fuzzy_string_resolve_hits: ${telemetry.fuzzy_string_resolve_hits}`);
    console.log(`  no_match:                  ${telemetry.no_match}`);
    console.log(`  by_cui_collisions:         ${telemetry.by_cui_collisions}`);
    console.log(`  by_string_collisions:      ${telemetry.by_string_collisions}`);
    console.log(`  concepts_missing_sid:      ${telemetry.concepts_missing_sid}`);
    console.log(`  diseases_with_snomed_links:${diseasesWithLinks}/${diseases.length}`);
    console.log(`  trials_with_snomed_links:  ${trialsWithLinks}/${trials.length}`);
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
