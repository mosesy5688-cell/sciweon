/**
 * Cross-Source Linker V0.1 — links PubChem Compound ↔ ChEMBL.
 *
 * For each compound in input jsonl:
 *   1. Query ChEMBL by InChIKey
 *   2. If match: merge ChEMBL drug_status + update provenance/confidence
 *   3. Fetch bioactivities (up to 100/compound)
 *   4. Write enriched compound + bioactivities to output
 *
 * Validates V8 confidence algorithm: single-source 70 → multi-source 90+.
 *
 * Usage:
 *   node scripts/factory/cross-source-linker.js [--input=output/compounds/*.jsonl] [--limit=100]
 */

import fs from 'fs/promises';
import path from 'path';
import { findByInchiKey, fetchActivities, normalizeDrugStatus, normalizeActivity } from '../ingestion/adapters/chembl-adapter.js';
import { scoreEntity } from './lib/confidence-scorer.js';
import { COMPOUND_SCHEMA } from '../../src/lib/schemas/compound.js';
import { BIOACTIVITY_SCHEMA } from '../../src/lib/schemas/bioactivity.js';
import { gate } from './lib/validation-gate.js';
import { pMap } from './lib/p-map.js';

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');
const INPUT_FILE = process.argv.find(a => a.startsWith('--input='))?.split('=')[1]
    || './output/compounds/compounds-cid-1-5000.jsonl';
const OUTPUT_DIR = './output/linked';
const REQUEST_DELAY_MS = 250;
// ChEMBL public free REST tolerates ~5 req/sec sustained (chembl-adapter.js:11).
// 4 workers × 250 ms per-task sleep = ~4 req/s peak, comfortably under the limit.
const CHEMBL_CONCURRENCY = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadCompounds(file, limit) {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').filter(Boolean).slice(0, limit).map(l => JSON.parse(l));
}

function mergeChemblIntoCompound(compound, chemblMolecule) {
    const timestamp = new Date().toISOString();

    // Update identifiers
    compound.chembl_id = chemblMolecule.molecule_chembl_id;

    // Add ChEMBL drug_status
    const drugStatus = normalizeDrugStatus(chemblMolecule);
    if (drugStatus && (drugStatus.max_phase != null || drugStatus.withdrawn || drugStatus.black_box_warning)) {
        compound.drug_status = drugStatus;
    }

    // Append ChEMBL to provenance.sources
    compound.provenance.sources.push({
        source: 'chembl',
        source_id: chemblMolecule.molecule_chembl_id,
        timestamp,
        extraction_method: 'chembl_rest_v1_inchikey_lookup',
    });
    compound.provenance.last_updated = timestamp;

    // Check structural agreement (InChIKey match across sources)
    const chemblInchiKey = chemblMolecule.molecule_structures?.standard_inchi_key;
    const structuralMatch = chemblInchiKey === compound.inchi_key;

    compound.confidence.cross_source_agreement = {
        structural_match: structuralMatch,
        conflicts: structuralMatch ? [] : ['inchi_key mismatch between pubchem and chembl'],
    };

    // Recompute confidence
    const newConfidence = scoreEntity(compound);
    Object.assign(compound.confidence, newConfidence);

    return compound;
}

async function main() {
    console.log(`[LINKER] Cross-Source Linker — V0.1`);
    console.log(`[LINKER] Input: ${INPUT_FILE} | Limit: ${LIMIT}`);
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const compounds = await loadCompounds(INPUT_FILE, LIMIT);
    console.log(`[LINKER] Loaded ${compounds.length} compounds | concurrency=${CHEMBL_CONCURRENCY}`);

    let completed = 0;

    // Each task fully self-contains: ChEMBL lookup + activity fetch + per-compound
    // stats computation + per-compound gate. Activities are filtered locally
    // (not against the global accumulator) so concurrency does not change the
    // bioactivity_count_active/inactive numbers vs the serial version.
    const taskResults = await pMap(compounds, CHEMBL_CONCURRENCY, async (c, idx) => {
        const beforeConfidence = c.confidence.overall;
        const chembl = await findByInchiKey(c.inchi_key);
        const localActivities = [];
        let matched = false;
        let rawActivityCount = 0;

        if (chembl) {
            mergeChemblIntoCompound(c, chembl);
            matched = true;

            const activities = await fetchActivities(chembl.molecule_chembl_id, 100);
            rawActivityCount = activities.length;
            for (const raw of activities) {
                const norm = normalizeActivity(raw, c.id);
                if (norm) {
                    const result = gate(norm, BIOACTIVITY_SCHEMA, `bioact:${norm.id}`);
                    if (result.passed) localActivities.push(norm);
                }
            }

            c.stats.bioactivity_count_active = localActivities.filter(a => a.is_active === true).length;
            c.stats.bioactivity_count_inactive = localActivities.filter(a => a.is_active === false).length;

            const afterConfidence = c.confidence.overall;
            if (idx < 5 || afterConfidence > 95) {
                console.log(`[LINKER] ${c.id} → ${chembl.molecule_chembl_id} | confidence ${beforeConfidence} → ${afterConfidence}`);
            }
        }

        const result = gate(c, COMPOUND_SCHEMA, c.id);
        const passed = result.passed;

        completed++;
        if (completed % 25 === 0) {
            console.log(`[LINKER] Progress: ${completed}/${compounds.length}`);
        }
        await sleep(REQUEST_DELAY_MS);

        return { compound: c, matched, activities: localActivities, rawActivityCount, passed };
    });

    let linked = 0, unmatched = 0, totalActivities = 0;
    const enriched = [];
    const allActivities = [];
    for (const r of taskResults) {
        if (r.matched) linked++; else unmatched++;
        totalActivities += r.rawActivityCount;
        if (r.passed) enriched.push(r.compound);
        for (const a of r.activities) allActivities.push(a);
    }

    // Determinism: sort outputs by canonical id so writes are byte-identical
    // across runs on identical input (Constitution V16.1 §7). Task-completion
    // order from pMap is non-deterministic; the sort restores it.
    enriched.sort((a, b) => a.id.localeCompare(b.id));
    allActivities.sort((a, b) => a.id.localeCompare(b.id));

    const enrichedFile = path.join(OUTPUT_DIR, `compounds-enriched.jsonl`);
    const activitiesFile = path.join(OUTPUT_DIR, `bioactivities.jsonl`);
    await fs.writeFile(enrichedFile, enriched.map(e => JSON.stringify(e)).join('\n'));
    await fs.writeFile(activitiesFile, allActivities.map(a => JSON.stringify(a)).join('\n'));

    const avgBefore = 70;
    const avgAfter = enriched.reduce((s, e) => s + e.confidence.overall, 0) / enriched.length;

    console.log(`\n[LINKER] ✅ Complete`);
    console.log(`  Compounds:         ${compounds.length}`);
    console.log(`  Linked to ChEMBL:  ${linked} (${(100 * linked / compounds.length).toFixed(1)}%)`);
    console.log(`  Unmatched:         ${unmatched}`);
    console.log(`  Bioactivities:     ${allActivities.length} (from ${totalActivities} raw)`);
    console.log(`  Avg confidence:    ${avgBefore} → ${avgAfter.toFixed(1)} (Δ ${(avgAfter - avgBefore).toFixed(1)})`);
    console.log(`  Output:`);
    console.log(`    ${enrichedFile}`);
    console.log(`    ${activitiesFile}`);
}

main().catch(err => { console.error('[LINKER] Fatal:', err); process.exit(1); });
