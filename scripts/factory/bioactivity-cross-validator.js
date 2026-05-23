/**
 * Bioactivity Cross-Validator V0.4 (cycle 22 PR-CORE-2) — PubChem BioAssay consensus.
 *
 * Existing bioactivities.jsonl carries measurements from ChEMBL.
 * PubChem BioAssay aggregates from an independent pool (NIH MLP / NCI /
 * academic / industry deposits). Cross-source consensus = same compound
 * + target + activity_type has records in both pools.
 *
 * V0.4 (PR-CORE-2): cursor + skip-if-stamped.
 *   - Cursor is over distinct compound_ids (the expensive PubChem assay
 *     fetch is per-CID), iterated in lex order with default chunk_size
 *     5000 CIDs/cycle.
 *   - Skip-if-stamped: a bioactivity is skipped iff
 *     `cross_source_consensus.has_pubchem_match` is already set (true OR
 *     false - both mean "we asked PubChem and recorded the answer").
 *     Only un-stamped bioactivities for compounds in this cycle's slice
 *     get processed.
 *
 * PR-CORE-1 baseline 2026-05-23: 5.58% (18891/338660). Old non-cursored
 * loop rebuilt the in-memory assayIndex from scratch every cycle and
 * walltime-exhausted before reaching the tail. R2 persistence of the
 * assayIndex itself is V2.
 *
 * Pipeline position: runs after target-resolver (which stamps
 * bioactivity.target.uniprot_accession).
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchAssaySummaryByCid, buildAssayIndex, crossValidateBioactivity, REQUEST_DELAY_MS } from '../ingestion/adapters/pubchem-bioassay-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';

const SOURCE = 'pubchem_bioassay';
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

// A bioactivity is skip-eligible (already stamped) when its
// cross_source_consensus.has_pubchem_match field is present (true or
// false - both are recorded outcomes per [[no_shortcut_in_science]]
// quality leg). Compound-id eligibility = at least one unstamped
// bioactivity exists for that compound.
export function unstampedBioactivities(bioacts) {
    return bioacts.filter(b => b?.cross_source_consensus?.has_pubchem_match == null);
}

export function distinctEligibleCompoundIds(unstamped) {
    const set = new Set();
    for (const b of unstamped) {
        if (b.compound_id) set.add(b.compound_id);
    }
    return [...set].map(id => ({ id }));
}

async function main() {
    console.log('[CROSS-VALIDATOR] V0.4 - cycle 22 PR-CORE-2 cursor-driven');

    const bioFile = path.join(DATA_DIR, 'bioactivities.jsonl');
    const bioacts = await loadJsonl(bioFile);
    console.log(`[CROSS-VALIDATOR] Loaded ${bioacts.length} bioactivities`);

    const unstamped = unstampedBioactivities(bioacts);
    console.log(`[CROSS-VALIDATOR] Unstamped: ${unstamped.length}`);
    if (unstamped.length === 0) {
        console.log('[CROSS-VALIDATOR] All bioactivities already stamped this cycle.');
        return;
    }

    const eligibleCids = distinctEligibleCompoundIds(unstamped);
    console.log(`[CROSS-VALIDATOR] Distinct unstamped compound_ids: ${eligibleCids.length}`);

    let cursor = null;
    try { cursor = await readCursor(SOURCE); }
    catch (err) { console.warn(`[CROSS-VALIDATOR] Cursor read failed (${err.message}) - starting fresh`); }
    const chunkSize = cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    const { slice, nextCursorId, wrapped, totalEligible } = chunkIterator(eligibleCids, cursor, chunkSize);
    console.log(`[CROSS-VALIDATOR] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | slice=${slice.length} | wrapped=${wrapped}`);

    const compoundIdSlice = new Set(slice.map(s => s.id));
    const cidByCompound = new Map();
    for (const compoundId of compoundIdSlice) {
        const numeric = extractCidFromCompoundId(compoundId);
        if (numeric != null) cidByCompound.set(compoundId, numeric);
    }
    console.log(`[CROSS-VALIDATOR] Resolvable to numeric CID: ${cidByCompound.size}`);

    const assayIndexByCompound = new Map();
    let processed = 0;
    for (const [compoundId, cid] of cidByCompound) {
        try {
            const rows = await fetchAssaySummaryByCid(cid);
            const idx = buildAssayIndex(rows);
            assayIndexByCompound.set(compoundId, idx);
        } catch (err) {
            console.warn(`[CROSS-VALIDATOR] CID ${cid} fetch failed: ${err.message}`);
        }
        processed++;
        if (processed % 50 === 0 || processed === cidByCompound.size) {
            console.log(`[CROSS-VALIDATOR] PubChem: ${processed}/${cidByCompound.size}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    let stamped = 0, withMatch = 0;
    for (const b of bioacts) {
        if (!compoundIdSlice.has(b.compound_id)) continue;
        if (b?.cross_source_consensus?.has_pubchem_match != null) continue;
        const idx = assayIndexByCompound.get(b.compound_id);
        if (!idx) {
            b.cross_source_consensus = { has_pubchem_match: false, pubchem_aid_count: 0, value_agreement: null, n_sources: 1 };
            stamped++;
            continue;
        }
        const consensus = crossValidateBioactivity(b, idx);
        b.cross_source_consensus = consensus;
        if (consensus.has_pubchem_match) withMatch++;
        bumpConfidence(b, consensus);
        stamped++;
    }

    await writeJsonl(bioFile, bioacts);

    const nextCursor = buildNextCursor({
        source: SOURCE, prev: cursor,
        chunkResult: { slice, nextCursorId, wrapped, totalEligible },
        processedCount: processed, totalEligible,
    });
    try {
        await writeCursor(SOURCE, nextCursor);
        console.log(`[CROSS-VALIDATOR] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
    } catch (err) {
        console.error(`[CROSS-VALIDATOR] Cursor write failed: ${err.message}`);
        throw err;
    }

    console.log(`\n[CROSS-VALIDATOR] Complete - this cycle: ${stamped} bioactivities stamped | ${withMatch} matched PubChem`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[CROSS-VALIDATOR] Fatal:', err); process.exit(1); });
}
