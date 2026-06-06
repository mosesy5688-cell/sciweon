/**
 * FDA Enricher V0.4 (PR-T1.1a, R4 cursor) — openFDA drug labels + recalls.
 *
 * For each compound with a FDA UNII, fetch FDA drug label(s) + enforcement
 * (recall) records PAGINATED TO COMPLETION (R3) and aggregate to a compact
 * fda_signals object on the compound (preserve-all, no slices).
 *
 * R4 CURSOR (the budget/staging fix): historically this re-walked the FULL
 * withUnii set every cron with NO cursor. The faers re-enrich + this paginated
 * re-fetch share the openFDA 120k/day quota + the ONE TokenBucket -- both
 * full-walking the corpus in the same cron blows the budget. This now drains
 * INCREMENTALLY via the SAME enrichment-cursor + drain-adapter-backlog pattern
 * the faers enricher uses, with a version/skip-if-stamped eligibility so an
 * already-enriched compound LEAVES the eligible set (one-shot-convergent) and
 * never-queried new compounds are not starved.
 *
 * Pipeline position: runs after compound-id-resolver (which populates
 * external_ids.unii). Operates in place on compounds-enriched.jsonl.
 */

import fs from 'fs/promises';
import path from 'path';
import {
    fetchLabelsByUnii, fetchRecallsByUnii, aggregateSignals, REQUEST_DELAY_MS,
} from '../ingestion/adapters/openfda-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS } from './lib/drain-adapter-backlog.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const SOURCE = 'openfda_label_recall';
const DATA_DIR = './output/linked';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 25 * 60 * 1000;
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || DEFAULT_CHUNK_DURATION_ESTIMATE_MS;

// R4 one-shot-convergent version. Bumped to 2 for the PR-T1.1a uncap (full
// pagination + boxed_warnings[]): a record stamped < 2 (or never stamped) is
// re-eligible so the uncap re-fetches already-enriched v1 compounds, then
// converges (LEAVES the eligible set) once re-fetched at v2.
export const CURRENT_FDA_ENRICH_VERSION = 2;

// LOUD per-minute failure telemetry (the enricher had none today). Mirrors the
// faers enricher's failuresByMinute so a 429/outage burst is a visible RATE.
let fdaErrorCount = 0;
const fdaFailuresByMinute = new Map();

function recordFdaFailure() {
    fdaErrorCount += 1;
    const minute = Math.floor(Date.now() / 60000);
    fdaFailuresByMinute.set(minute, (fdaFailuresByMinute.get(minute) ?? 0) + 1);
}

export function fdaTelemetry() {
    let peakPerMin = 0;
    for (const v of fdaFailuresByMinute.values()) peakPerMin = Math.max(peakPerMin, v);
    return { fdaErrorCount, peakFailuresPerMinute: peakPerMin };
}

/**
 * FILL-not-replace merge ([[cross_cycle_silent_data_loss]]). aggregateSignals
 * carries NO faers_* fields, so a full replace wiped the prior-cycle FAERS
 * Cat-E signal that compound-faers-enricher stamps onto the SAME object.
 */
export function mergeFdaSignals(existing, signals) {
    return { ...(existing || {}), ...signals };
}

// Skip-if-stamped (R4): a compound LEAVES the eligible set once its
// fda_signals.fda_enrich_version reaches CURRENT. A fetch failure leaves the
// version UN-bumped so the record stays eligible + is retried next cron.
export function isEligible(record) {
    if (!record?.external_ids?.unii) return false;
    const v = record?.fda_signals?.fda_enrich_version ?? 0;
    return v < CURRENT_FDA_ENRICH_VERSION;
}

// enrichOne MUST NEVER THROW: a poison UNII would otherwise abort the stage.
// On a FETCH FAILURE (labels or recalls null) it does NOT stamp the version
// (stays eligible, retried next cron) per the sentinel contract.
export async function enrichOne(record) {
    const unii = record.external_ids?.unii;
    if (!unii) return record;

    let labels = null; let recalls = null;
    try {
        labels = await fetchLabelsByUnii(unii);
        await sleep(REQUEST_DELAY_MS);
        recalls = await fetchRecallsByUnii(unii);
    } catch {
        labels = null; recalls = null;     // belt-and-suspenders, never throw
    }

    if (labels === null || recalls === null) {
        // FETCH FAILURE: do NOT stamp the version -> stays eligible.
        recordFdaFailure();
        return record;
    }

    const signals = aggregateSignals(labels.results, recalls.results, {
        labelTruncated: labels.truncated, recallTruncated: recalls.truncated,
    });
    // signals === null means genuine-empty (no label + no recall). Still a
    // GENUINE outcome -> stamp the version so the record converges (no infinite
    // re-query of a UNII that genuinely has no FDA data).
    record.fda_signals = mergeFdaSignals(record.fda_signals, signals ?? {});
    record.fda_signals.fda_enrich_version = CURRENT_FDA_ENRICH_VERSION;
    return record;
}

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

async function main() {
    console.log('[FDA-ENRICHER] V0.4 (R4 cursor) — openFDA labels + recalls, paginated');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonlStrict(file);
    console.log(`[FDA-ENRICHER] Loaded ${compounds.length} compounds`);

    const eligible = compounds.filter(isEligible);
    console.log(`[FDA-ENRICHER] Eligible (UNII present, fda_enrich_version < ${CURRENT_FDA_ENRICH_VERSION}): ${eligible.length}`);
    if (eligible.length === 0) { console.log('[FDA-ENRICHER] Nothing to do this cycle.'); return; }

    let cursor = null;
    try { cursor = await readCursor(SOURCE); }
    catch (err) { console.warn(`[FDA-ENRICHER] Cursor read failed (${err.message}) - fresh`); }
    const chunkSize = cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    console.log(`[FDA-ENRICHER] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | budget=${(DRAIN_BUDGET_MS / 60000).toFixed(1)}min`);

    const drain = await drainAdapterBacklog({
        eligible, enrichOne, chunkIterator, chunkSize,
        timeBudgetMs: DRAIN_BUDGET_MS, coldStartEstimateMs: COLD_START_MS,
        sleepMsBetween: REQUEST_DELAY_MS, initialCursor: cursor,
        logPrefix: '[FDA-ENRICHER]', logEveryNRecords: 25,
    });
    console.log(`[FDA-ENRICHER] Drain done | terminatedBy=${drain.terminatedBy} | chunksDrained=${drain.chunksDrained} | processedInRun=${drain.processedInRun} | remainingBacklog=${drain.remainingBacklog}`);

    await writeJsonl(file, compounds);
    if (drain.finalCursorResult) {
        const nextCursor = buildNextCursor({
            source: SOURCE, prev: cursor, chunkResult: drain.finalCursorResult,
            processedCount: drain.processedInRun, totalEligible: drain.finalCursorResult.totalEligible,
        });
        try {
            await writeCursor(SOURCE, nextCursor);
            console.log(`[FDA-ENRICHER] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
        } catch (err) { console.error(`[FDA-ENRICHER] Cursor write failed: ${err.message}`); throw err; }
    }

    const tel = fdaTelemetry();
    let labelHit = 0; let recallHit = 0; let boxed = 0;
    for (const c of compounds) {
        if (c.fda_signals?.label_count > 0) labelHit++;
        if (c.fda_signals?.recall_count > 0) recallHit++;
        if (c.fda_signals?.has_boxed_warning) boxed++;
    }
    console.log(`\n[FDA-ENRICHER] Complete | labels: ${labelHit} | recalls: ${recallHit} | boxed: ${boxed}`);
    console.log(`[FDA-ENRICHER] Fetch-failure telemetry: errors=${tel.fdaErrorCount} | peak_failures_per_minute=${tel.peakFailuresPerMinute}`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[FDA-ENRICHER] Fatal:', err); process.exit(1); });
