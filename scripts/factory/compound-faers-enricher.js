/**
 * Compound FAERS Enricher V0.5 (cycle 22 PR-CORE-2) — quantified safety signals.
 *
 * openFDA `count=patient.reaction.reactionmeddrapt.exact` returns top ADR
 * terms with FAERS report counts in a single API call keyed by UNII.
 * Result: each UNII-bearing compound gains `fda_signals.faers_top_adr_terms`
 * and `faers_total_top_count` (NegEvidence Cat E signal-level).
 *
 * V0.5 (PR-CORE-2): cursor + skip-if-stamped. Eligibility:
 *   - external_ids.unii present (gate)
 *   - fda_signals.faers_top_adr_terms not yet populated (skip)
 * Cursor at R2 state/enrichment-cursor/openfda_faers.json. Default
 * chunk_size 5000 — at 250ms/record yields ~21 min/cycle, within stage-2
 * 350-min budget. PR-CORE-1 baseline 2026-05-23 showed only 2.36%
 * gate-adjusted coverage because the old non-cursored loop walltime-
 * exhausted after the array prefix.
 *
 * Pipeline position: runs after fda-enricher (which produces fda_signals
 * baseline) and compound-id-resolver (which populates UNII).
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchFaersSignalsByUnii, REQUEST_DELAY_MS } from '../ingestion/adapters/openfda-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';

const SOURCE = 'openfda_faers';
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

// Skip-if-stamped: a compound is FAERS-enriched once
// fda_signals.faers_top_adr_terms array has been written (whether or not
// it contains entries - empty array means "queried, no signals" which is
// still informative). Eligibility requires UNII (denominator gate).
export function isEligible(record) {
    if (!record?.external_ids?.unii) return false;
    const terms = record?.fda_signals?.faers_top_adr_terms;
    if (Array.isArray(terms)) return false; // already attempted
    return true;
}

export async function enrichOne(record) {
    const unii = record.external_ids?.unii;
    if (!unii) return record;
    const signals = await fetchFaersSignalsByUnii(unii, 30);
    record.fda_signals = record.fda_signals ?? { sources: [] };
    // Always stamp the array (possibly empty) so skip-if-stamped works.
    record.fda_signals.faers_top_adr_terms = (signals ?? []).slice(0, 30);
    record.fda_signals.faers_total_top_count = (signals ?? []).reduce((s, r) => s + r.count, 0);
    if (!Array.isArray(record.fda_signals.sources)) record.fda_signals.sources = [];
    if (signals?.length > 0 && !record.fda_signals.sources.includes('openfda_faers')) {
        record.fda_signals.sources.push('openfda_faers');
    }
    return record;
}

async function main() {
    console.log('[FAERS-ENRICHER] V0.5 - cycle 22 PR-CORE-2 cursor-driven');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[FAERS-ENRICHER] Loaded ${compounds.length} compounds`);

    const eligible = compounds.filter(isEligible);
    console.log(`[FAERS-ENRICHER] Eligible (UNII present, FAERS not yet stamped): ${eligible.length}`);

    if (eligible.length === 0) {
        console.log('[FAERS-ENRICHER] Nothing to do this cycle.');
        return;
    }

    let cursor = null;
    try { cursor = await readCursor(SOURCE); }
    catch (err) { console.warn(`[FAERS-ENRICHER] Cursor read failed (${err.message}) - starting fresh`); }
    const chunkSize = cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    const { slice, nextCursorId, wrapped, totalEligible } = chunkIterator(eligible, cursor, chunkSize);

    console.log(`[FAERS-ENRICHER] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | slice=${slice.length} | wrapped=${wrapped}`);

    let withFaersData = 0;
    let totalReports = 0;
    let processed = 0;
    for (const rec of slice) {
        await enrichOne(rec);
        if (rec.fda_signals?.faers_top_adr_terms?.length > 0) {
            withFaersData++;
            totalReports += rec.fda_signals.faers_total_top_count ?? 0;
        }
        processed++;
        if (processed % 100 === 0 || processed === slice.length) {
            console.log(`[FAERS-ENRICHER] ${processed}/${slice.length} | with FAERS: ${withFaersData}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    await writeJsonl(file, compounds);

    const nextCursor = buildNextCursor({
        source: SOURCE, prev: cursor,
        chunkResult: { slice, nextCursorId, wrapped, totalEligible },
        processedCount: processed, totalEligible,
    });
    try {
        await writeCursor(SOURCE, nextCursor);
        console.log(`[FAERS-ENRICHER] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
    } catch (err) {
        console.error(`[FAERS-ENRICHER] Cursor write failed: ${err.message}`);
        throw err;
    }

    console.log(`\n[FAERS-ENRICHER] Complete - ${withFaersData}/${processed} this cycle | ${totalReports.toLocaleString()} reports captured`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[FAERS-ENRICHER] Fatal:', err); process.exit(1); });
}
