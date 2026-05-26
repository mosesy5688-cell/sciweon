/**
 * Compound FDA SRS enricher (Phase 1.8 PR-FDA-SRS-2).
 *
 * F2-layer enricher running AFTER compound-id-resolver (UniChem) + BEFORE
 * compound-rxnorm. Loads the published FDA SRS UNII lookup from R2 once
 * at start, then drains the cumulative compounds-enriched.jsonl backlog
 * via drainAdapterBacklog V5 template. Each enrichOne is O(1) Map lookup
 * (no network/API/sleep); first-wins null-only fill preserves prior
 * UniChem-stamped UNII while adding fda_srs source membership.
 *
 * Architect-locked rails active here:
 *   Rail 5 -- normalizeInChIKey reused via adapter SSoT
 *   Rail 6 -- overlap disagreement telemetry: emit [FDA-SRS-CONFLICT]
 *             console.warn when prior unii differs from FDA SRS unii;
 *             FIRST-WINS preserved (no behavior change vs V5 template)
 *   Rail 10a -- shared-reference lookup; direct scalar field assignment
 *             in enrichOne; no deep clone -> GC-flat heap profile
 *   Rail 10b -- Max-10 conflict warning truncation per F2 run; subsequent
 *             conflicts atomic-counted only, summary emitted at drain end
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';
import { drainAdapterBacklog } from './lib/drain-adapter-backlog.js';
import { loadLookupFromR2, lookupByInchiKey } from '../ingestion/adapters/fda-srs-adapter.js';

const SOURCE = 'fda_srs';
const DATA_DIR = './output/linked';
// 5-minute compact budget for local O(1) Map lookup (sleepMsBetween=0).
// Realistic worst-case full-corpus drain < 30s; 5min is 10x safety margin.
// Faster anomaly detection (OOM / hang / loop) than the 25min cross-adapter default.
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 5 * 60 * 1000;
// PR-FDA-SRS-2b: cold-start MUST be calibrated for local-lookup adapter, NOT
// the 17-min DEFAULT_CHUNK_DURATION_ESTIMATE_MS network-API global. The
// drain helper's pre-chunk-1 gate check `elapsed(0) + projected(17min*1.1)
// > budget(5min)` would always fire -> 0 chunks ever drained. 30s estimate
// (* 1.1 = 33s) safely below the 5min budget while still defensive for
// realistic chunk wall <1s.
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || 30 * 1000;
const MAX_CONFLICT_WARN = 10;  // Rail 10b truncation ceiling per F2 run

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

// Streaming JSONL writer (V5 architect-locked V8-thread defense).
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

// Eligibility: has inchi_key AND not yet fda_srs-stamped. NOT predicated
// on !unii because FDA SRS provides authoritative cross-validation even
// on UniChem-overlapping records (Rail 6 enables empirical capture).
export function isEligible(record) {
    if (!record?.inchi_key) return false;
    const srcs = record?.external_ids?.sources;
    if (Array.isArray(srcs) && srcs.includes(SOURCE)) return false;
    return true;
}

// Build the enrichOne closure with access to the in-memory lookup Map +
// per-run conflict counter (Rail 10b). The closure pattern lets the drain
// helper stay generic while this adapter retains lookup-map context.
export function makeEnrichOne(map, conflictState) {
    return async function enrichOne(record) {
        const xref = lookupByInchiKey(record.inchi_key, map);
        if (!xref) return record;  // FDA SRS has no entry for this InChIKey
        // Rail 10a: direct scalar assignment on shared-reference target;
        // no deep clone allocations -> GC-flat heap on 5000-chunk rotation.
        const external = record.external_ids ?? { sources: [] };
        if (!Array.isArray(external.sources)) external.sources = [];

        // Rail 6 disagreement telemetry (first-wins behavior preserved).
        if (external.unii != null && external.unii !== xref.unii) {
            conflictState.count++;
            if (conflictState.warnedSamples < MAX_CONFLICT_WARN) {
                console.warn(`[FDA-SRS-CONFLICT] ${record.id} InChIKey ${record.inchi_key}: prior unii=${external.unii} (from ${external.sources.join(',')}) differs from FDA SRS unii=${xref.unii} -- keeping prior (first-wins)`);
                conflictState.warnedSamples++;
            }
        }

        if (external.unii == null && xref.unii) external.unii = xref.unii;
        if (external.preferred_name == null && xref.preferred_name) external.preferred_name = xref.preferred_name;
        if (external.cas_rn == null && xref.cas_rn) external.cas_rn = xref.cas_rn;
        if (!external.sources.includes(SOURCE)) external.sources.push(SOURCE);
        record.external_ids = external;
        return record;
    };
}

async function main() {
    console.log(`[FDA-SRS-ENRICHER] V1 - Phase 1.8 PR-FDA-SRS-2 cursor + drain template`);

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[FDA-SRS-ENRICHER] Loaded ${compounds.length} compounds`);

    const eligible = compounds.filter(isEligible);
    console.log(`[FDA-SRS-ENRICHER] Eligible (inchi_key present, not yet fda_srs-stamped): ${eligible.length}`);
    if (eligible.length === 0) {
        console.log('[FDA-SRS-ENRICHER] Nothing to do this cycle.');
        return;
    }

    const { map, cursor: lookupCursor, telemetry } = await loadLookupFromR2();
    console.log(`[FDA-SRS-ENRICHER] Lookup map ready: ${map.size} InChIKey -> UNII entries (from ${lookupCursor.r2_data_key})`);

    let cursor = null;
    try { cursor = await readCursor(SOURCE); }
    catch (err) { console.warn(`[FDA-SRS-ENRICHER] Cursor read failed (${err.message}) - starting fresh`); }
    const chunkSize = cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    console.log(`[FDA-SRS-ENRICHER] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | budget=${(DRAIN_BUDGET_MS / 60000).toFixed(1)}min | coldStart=${(COLD_START_MS / 60000).toFixed(1)}min`);

    const conflictState = { count: 0, warnedSamples: 0 };
    const enrichOne = makeEnrichOne(map, conflictState);

    const drain = await drainAdapterBacklog({
        eligible, enrichOne, chunkIterator, chunkSize,
        timeBudgetMs: DRAIN_BUDGET_MS, coldStartEstimateMs: COLD_START_MS,
        sleepMsBetween: 0, initialCursor: cursor,
        logPrefix: '[FDA-SRS-ENRICHER]', logEveryNRecords: 500,
    });
    console.log(`[FDA-SRS-ENRICHER] Drain done | terminatedBy=${drain.terminatedBy} | chunksDrained=${drain.chunksDrained} | processedInRun=${drain.processedInRun} | remainingBacklog=${drain.remainingBacklog}`);
    if (conflictState.count > 0) {
        console.warn(`[FDA-SRS-ENRICHER] Rail 10b conflict summary: ${conflictState.count} total InChIKey/UNII disagreements observed this run (first ${conflictState.warnedSamples} samples logged above; remainder atomic-counted only)`);
    }

    let stamped = 0, withUnii = 0;
    for (const rec of compounds) {
        if (rec.external_ids?.sources?.includes(SOURCE)) stamped++;
        if (rec.external_ids?.unii) withUnii++;
    }

    await writeJsonl(file, compounds);
    if (drain.finalCursorResult) {
        const nextCursor = buildNextCursor({
            source: SOURCE, prev: cursor,
            chunkResult: drain.finalCursorResult,
            processedCount: drain.processedInRun,
            totalEligible: drain.finalCursorResult.totalEligible,
        });
        try {
            await writeCursor(SOURCE, nextCursor);
            console.log(`[FDA-SRS-ENRICHER] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
        } catch (err) {
            console.error(`[FDA-SRS-ENRICHER] Cursor write failed: ${err.message}`);
            throw err;
        }
    } else {
        console.log('[FDA-SRS-ENRICHER] No chunks drained -- cursor unchanged');
    }

    console.log(`\n[FDA-SRS-ENRICHER] Complete - cumulative fda_srs-stamped: ${stamped}/${compounds.length} | with UNII (any source): ${withUnii}/${compounds.length}`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[FDA-SRS-ENRICHER] Fatal:', err); process.exit(1); });
