/**
 * MeSH Cross-link Enricher -- PR-UMLS-2 F2 orchestrator (paper <-> mesh_concept).
 *
 * Runs AFTER the SID stamping loop (so mesh-concepts.jsonl carries sid_s). Loads
 * output/linked/papers.jsonl + output/linked/mesh-concepts.jsonl, attaches
 * paper.mesh_links via the two-channel cross-link (code_join Part A,
 * string_resolve Part B), and rewrites papers.jsonl in place.
 *
 * DECISION 5: paper-only (disease.db_xrefs + trial.conditions are follow-on).
 * DECISION 3: idempotent overwrite of paper.mesh_links; sid_s/sid_c untouched.
 * Fail-soft per-term + loud bucketed telemetry (no silent drop). Heavy logic lives
 * in lib/mesh-crosslink-helpers.js (pure, unit-tested); this orchestrator owns IO.
 *
 * Non-throwing on an absent mesh-concepts.jsonl is NOT permitted: this enricher is
 * wired immediately after the hard-fail stamping loop, so the stamped concept file
 * MUST exist. A missing/empty concept file would silently zero every paper's
 * mesh_links -- so we HALT loud if the concept corpus is empty.
 */

import fs from 'fs/promises';
import path from 'path';
import { enrichPapersWithMeshLinks } from './lib/mesh-crosslink-helpers.js';
import { loadJsonlStrict, assertLoaded } from './lib/jsonl-io.js';

const OUTPUT_DIR = './output/linked';
const LABEL = 'MESH-XLINK';

async function writeJsonl(file, records) {
    // join() is stack-safe at any size (Defect-15 lesson).
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''));
}

async function main() {
    console.log(`[${LABEL}] PR-UMLS-2 F2 paper<->mesh_concept cross-link`);

    const papersPath = path.join(OUTPUT_DIR, 'papers.jsonl');
    const meshPath = path.join(OUTPUT_DIR, 'mesh-concepts.jsonl');
    const papers = await loadJsonlStrict(papersPath);
    const concepts = await loadJsonlStrict(meshPath);
    console.log(`[${LABEL}] Loaded ${papers.length} papers, ${concepts.length} stamped MeSH concepts`);

    // HALT loud (no silent data loss): papers is overwritten in place, so 0 papers is an anomaly --
    // refuse to truncate it. Then HALT on 0 concepts (would zero every paper's mesh_links). Both
    // run BEFORE writeJsonl.
    assertLoaded(papers, LABEL, papersPath);
    assertLoaded(concepts, LABEL, meshPath);

    const telemetry = enrichPapersWithMeshLinks(papers, concepts);

    await writeJsonl(papersPath, papers);

    const papersWithLinks = papers.filter(p => Array.isArray(p.mesh_links) && p.mesh_links.length > 0).length;
    console.log(`[${LABEL}] === TELEMETRY ===`);
    console.log(`  papers_processed:      ${telemetry.papers_processed}`);
    console.log(`  terms_total:           ${telemetry.terms_total}`);
    console.log(`  code_join_hits:        ${telemetry.code_join_hits}`);
    console.log(`  string_resolve_hits:   ${telemetry.string_resolve_hits}`);
    console.log(`  no_match:              ${telemetry.no_match}`);
    console.log(`  string_map_collisions: ${telemetry.string_map_collisions}`);
    console.log(`  concepts_missing_sid:  ${telemetry.concepts_missing_sid}`);
    console.log(`  papers_with_mesh_links:${papersWithLinks}/${papers.length}`);
    if (telemetry.no_match_samples.length > 0) {
        console.log(`  no_match_samples:      ${JSON.stringify(telemetry.no_match_samples)}`);
    }
    console.log(`[${LABEL}] SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
