/**
 * Bioactivity Cross-Validator V0.3.1 — PubChem BioAssay measurement consensus.
 *
 * Existing bioactivities.jsonl carries measurements sourced from ChEMBL
 * (pharmaceutical literature curated by EMBL-EBI). PubChem BioAssay
 * aggregates from an independent pool (NIH MLP / NCI / academic / industry
 * deposits). When the same compound + target + activity_type has records
 * in both, we have genuine cross-source consensus.
 *
 * Pipeline position: runs after target-resolver (which stamps
 * bioactivity.target.uniprot_accession). Operates in place on
 * output/linked/bioactivities.jsonl.
 *
 * Steps:
 *   1. Load bioactivities.jsonl
 *   2. Collect unique CIDs (Sciweon compound IDs -> pubchem_cid)
 *   3. For each CID: fetch PubChem assaysummary -> build per-compound index
 *   4. For each bioactivity: cross-validate against its compound's index
 *   5. Stamp `cross_source_consensus` on each record
 *   6. Bump sciweon_confidence: +10 on agree, +5 on soft_agree, -15 on conflict
 *   7. Save bioactivities.jsonl
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchAssaySummaryByCid, buildAssayIndex, crossValidateBioactivity, REQUEST_DELAY_MS } from '../ingestion/adapters/pubchem-bioassay-adapter.js';

const DATA_DIR = './output/linked';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

function extractCidFromCompoundId(compoundId) {
    const m = compoundId.match(/CID:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function bumpConfidence(bioactivity, consensus) {
    if (typeof bioactivity.sciweon_confidence !== 'number') return;
    let delta = 0;
    if (consensus.value_agreement === 'agree') delta = 10;
    else if (consensus.value_agreement === 'soft_agree') delta = 5;
    else if (consensus.value_agreement === 'conflict') delta = -15;
    bioactivity.sciweon_confidence = Math.max(0, Math.min(100,
        bioactivity.sciweon_confidence + delta));
}

async function main() {
    console.log('[CROSS-VALIDATOR] V0.3.1 — PubChem BioAssay measurement consensus');

    const bioFile = path.join(DATA_DIR, 'bioactivities.jsonl');
    const bioacts = await loadJsonl(bioFile);
    console.log(`[CROSS-VALIDATOR] Loaded ${bioacts.length} bioactivities`);

    const compoundIds = [...new Set(bioacts.map(b => b.compound_id))];
    const cidByCompound = new Map();
    for (const cid of compoundIds) {
        const numeric = extractCidFromCompoundId(cid);
        if (numeric) cidByCompound.set(cid, numeric);
    }
    console.log(`[CROSS-VALIDATOR] Unique compounds: ${compoundIds.length}, with parseable CID: ${cidByCompound.size}`);

    const assayIndexByCompound = new Map();
    let processed = 0;
    let totalRows = 0;
    let totalIndexed = 0;
    for (const [compoundId, cid] of cidByCompound) {
        const rows = await fetchAssaySummaryByCid(cid);
        const idx = buildAssayIndex(rows);
        assayIndexByCompound.set(compoundId, idx);
        totalRows += rows.length;
        totalIndexed += idx.size;
        processed++;
        if (processed % 25 === 0 || processed === cidByCompound.size) {
            console.log(`[CROSS-VALIDATOR] PubChem: ${processed}/${cidByCompound.size} compounds | total assay rows: ${totalRows} | indexed UniProt entries: ${totalIndexed}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    let withMatch = 0, agree = 0, softAgree = 0, conflict = 0, noMatch = 0;
    for (const b of bioacts) {
        const idx = assayIndexByCompound.get(b.compound_id);
        if (!idx) continue;
        const consensus = crossValidateBioactivity(b, idx);
        b.cross_source_consensus = consensus;
        if (consensus.has_pubchem_match) {
            withMatch++;
            if (consensus.value_agreement === 'agree') agree++;
            else if (consensus.value_agreement === 'soft_agree') softAgree++;
            else if (consensus.value_agreement === 'conflict') conflict++;
        } else {
            noMatch++;
        }
        bumpConfidence(b, consensus);
    }
    await writeJsonl(bioFile, bioacts);

    console.log(`\n[CROSS-VALIDATOR] Complete`);
    console.log(`  Bioactivities: ${bioacts.length}`);
    console.log(`  PubChem match: ${withMatch} (${(100 * withMatch / bioacts.length).toFixed(1)}%)`);
    console.log(`    value agreement -> agree: ${agree} | soft_agree: ${softAgree} | conflict: ${conflict}`);
    console.log(`  No PubChem match: ${noMatch}`);
    const dist = { '>=90': 0, '70-89': 0, '<70': 0 };
    for (const b of bioacts) {
        const c = b.sciweon_confidence;
        if (typeof c !== 'number') continue;
        if (c >= 90) dist['>=90']++;
        else if (c >= 70) dist['70-89']++;
        else dist['<70']++;
    }
    console.log(`  sciweon_confidence: ${JSON.stringify(dist)}`);
}

main().catch(err => { console.error('[CROSS-VALIDATOR] Fatal:', err); process.exit(1); });
