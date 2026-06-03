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

import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { fetchAssaySummaryByCid, buildAssayIndex, crossValidateBioactivity, REQUEST_DELAY_MS } from '../ingestion/adapters/pubchem-bioassay-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS } from './lib/drain-adapter-backlog.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const SOURCE = 'pubchem_bioassay';
const DATA_DIR = './output/linked';
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 25 * 60 * 1000;
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || DEFAULT_CHUNK_DURATION_ESTIMATE_MS;

// Streaming JSONL writer (V5 architect-locked V8-thread defense).
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
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
    const bioacts = await loadJsonlStrict(bioFile);
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
    console.log(`[CROSS-VALIDATOR] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | budget=${(DRAIN_BUDGET_MS / 60000).toFixed(1)}min | coldStart=${(COLD_START_MS / 60000).toFixed(1)}min`);

    // Pre-bucket bioactivities by compound_id once (O(N)) so per-compound
    // enrichOne does O(1) lookup instead of O(N) full-array scan per compound.
    // Without this bucketing 5000 compounds x 367K bioacts = 1.8B iterations.
    const bioactsByCompound = new Map();
    for (const b of bioacts) {
        if (!b?.compound_id) continue;
        if (!bioactsByCompound.has(b.compound_id)) bioactsByCompound.set(b.compound_id, []);
        bioactsByCompound.get(b.compound_id).push(b);
    }

    // Per-compound enricher closure: fetch PubChem assay summary, build
    // index, then stamp ALL bioactivities for this compound. Mutates
    // bioacts in-place via shared object refs.
    const enrichCompound = async ({ id: compoundId }) => {
        const cid = extractCidFromCompoundId(compoundId);
        let idx = null;
        if (cid != null) {
            try {
                const rows = await fetchAssaySummaryByCid(cid);
                idx = buildAssayIndex(rows);
            } catch (err) {
                console.warn(`[CROSS-VALIDATOR] CID ${cid} fetch failed: ${err.message}`);
            }
        }
        const compoundBioacts = bioactsByCompound.get(compoundId) || [];
        for (const b of compoundBioacts) {
            if (b?.cross_source_consensus?.has_pubchem_match != null) continue;
            if (!idx) {
                b.cross_source_consensus = { has_pubchem_match: false, pubchem_aid_count: 0, value_agreement: null, n_sources: 1 };
                continue;
            }
            const consensus = crossValidateBioactivity(b, idx);
            b.cross_source_consensus = consensus;
            bumpConfidence(b, consensus);
        }
    };

    // V5 drain-until-cleared at compound granularity. Each chunk drains
    // ~chunkSize compounds; budget gate fires if PubChem assay fetch tail
    // latency would exceed remaining budget.
    const drain = await drainAdapterBacklog({
        eligible: eligibleCids, enrichOne: enrichCompound, chunkIterator, chunkSize,
        timeBudgetMs: DRAIN_BUDGET_MS, coldStartEstimateMs: COLD_START_MS,
        sleepMsBetween: REQUEST_DELAY_MS, initialCursor: cursor,
        logPrefix: '[CROSS-VALIDATOR]', logEveryNRecords: 50,
    });
    console.log(`[CROSS-VALIDATOR] Drain done | terminatedBy=${drain.terminatedBy} | chunksDrained=${drain.chunksDrained} | processedInRun=${drain.processedInRun} | remainingBacklog=${drain.remainingBacklog}`);

    let stamped = 0, withMatch = 0;
    for (const b of bioacts) {
        if (b?.cross_source_consensus?.has_pubchem_match != null) {
            stamped++;
            if (b.cross_source_consensus.has_pubchem_match) withMatch++;
        }
    }

    // Terminal atomic commit (streaming writer for 367K records).
    await writeJsonl(bioFile, bioacts);
    if (drain.finalCursorResult) {
        const nextCursor = buildNextCursor({
            source: SOURCE, prev: cursor,
            chunkResult: drain.finalCursorResult,
            processedCount: drain.processedInRun,
            totalEligible: drain.finalCursorResult.totalEligible,
        });
        try {
            await writeCursor(SOURCE, nextCursor);
            console.log(`[CROSS-VALIDATOR] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
        } catch (err) {
            console.error(`[CROSS-VALIDATOR] Cursor write failed: ${err.message}`);
            throw err;
        }
    } else {
        console.log('[CROSS-VALIDATOR] No chunks drained (empty eligible at entry) -- cursor unchanged');
    }

    console.log(`\n[CROSS-VALIDATOR] Complete - cumulative stamped: ${stamped}/${bioacts.length} | ${withMatch} matched PubChem`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[CROSS-VALIDATOR] Fatal:', err); process.exit(1); });
}
