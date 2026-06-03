/**
 * Compound ID Resolver V0.3.4 (cycle 22 PR-CORE-2) — UniChem canonical IDs.
 *
 * One UniChem call per compound returns FDA UNII / DrugBank ID / ChEBI ID /
 * KEGG_DRUG / HMDB ID keyed by InChIKey. Each compound gains the
 * international canonical ID set used by FDA / EMA / NLM / hospital EHRs.
 *
 * V0.3.4 (PR-CORE-2): RxNorm chained-hop removed - the chain only ran on
 * compounds that resolved UNII in the same pass, never on the backlog of
 * UNII-bearing compounds from prior runs (PR-CORE-1 baseline 2026-05-23
 * showed only 9.6% gate-adjusted RxNorm coverage as a result). RxNorm now
 * has its own cursor-driven enricher: `compound-rxnorm-enricher.js`.
 *
 * Also adds cursor + skip-if-stamped per [[no_shortcut_in_science]]
 * triple-lock substrate. Eligibility: compound has not yet been
 * UniChem-stamped (sources array does not include 'unichem'). Cursor at
 * R2 state/enrichment-cursor/unichem.json. Default chunk_size 5000.
 *
 * Pipeline position: runs after cross-source-linker. Operates in place.
 */

import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { fetchByInchiKey, REQUEST_DELAY_MS as UNICHEM_DELAY } from '../ingestion/adapters/unichem-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS } from './lib/drain-adapter-backlog.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const SOURCE = 'unichem';
const DATA_DIR = './output/linked';
// Per-adapter drain wall-time budget. Default 25 min; env override allows
// faster fast-RTT adapters (e.g. RxNorm bulk file reader) to tune downward.
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 25 * 60 * 1000;
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || DEFAULT_CHUNK_DURATION_ESTIMATE_MS;

// Streaming JSONL writer (V5 architect-locked V8-thread defense). Releases
// the event loop between record writes via drain backpressure; avoids the
// 1.2-2.5s monolithic JSON.stringify freeze on 125MB+ master arrays which
// would otherwise corrupt downstream timing observability.
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) {
            await once(stream, 'drain');
        }
    }
    stream.end();
    await once(stream, 'finish');
}

// Skip-if-stamped: a compound is considered UniChem-resolved when its
// external_ids.sources array includes 'unichem' (matches
// SOURCE_REQUIRED_FIELDS.unichem predicate so PR-CORE-1 tracker and this
// enricher agree on "done"). Compounds without inchi_key are
// ineligible (UniChem keys lookups by InChIKey).
export function isEligible(record) {
    if (!record?.inchi_key) return false;
    const srcs = record?.external_ids?.sources;
    if (Array.isArray(srcs) && srcs.includes('unichem')) return false;
    return true;
}

export async function enrichOne(record) {
    const xrefs = await fetchByInchiKey(record.inchi_key);
    if (!xrefs) return record;
    const external = record.external_ids ?? { sources: [] };
    if (!Array.isArray(external.sources)) external.sources = [];
    if (!external.sources.includes('unichem')) external.sources.push('unichem');
    for (const [k, v] of Object.entries(xrefs)) {
        if (k === 'chembl_id' || k === 'pubchem_cid') continue; // already on entity
        if (external[k] == null) external[k] = v;
    }
    // PR-FDA-SRS-2c Option E (architect V6 lock): explicit provenance flag.
    // Set ONLY when UniChem REST API returned non-null xrefs (i.e., adapter
    // actually got data from the source). Decouples Layer 3 unichem validator
    // from external_ids.unii which FDA SRS now also writes -- prevents
    // false-credit metric pollution.
    external.unichem_matched = true;
    record.external_ids = external;
    return record;
}

// PR-FDA-SRS-2c bootstrap idempotency: at main() entry, auto-stamp
// unichem_matched=true on all historical records that already have
// sources includes 'unichem' AND unii non-null. These records were
// previously enriched by UniChem (UNII is exclusively UniChem-sourced
// per cont 43 forensic UNII-only count = 0); the flag backfill avoids
// re-running 84K historical fetchByInchiKey calls. Returns backfill count.
//
// One-time idempotent: subsequent runs find the flag already set + skip.
// Architect V6 spec: false-positives possible only on records FDA SRS
// has touched after #168 ship (~875 records); negligible vs 32K legit
// historical UniChem hits.
export function bootstrapUnichemMatchedFlag(compounds) {
    let backfilled = 0;
    for (const rec of compounds) {
        const ext = rec?.external_ids;
        if (!ext) continue;
        if (ext.unichem_matched === true) continue;
        if (Array.isArray(ext.sources) && ext.sources.includes('unichem') && ext.unii != null) {
            ext.unichem_matched = true;
            backfilled++;
        }
    }
    return backfilled;
}

async function main() {
    console.log('[ID-RESOLVER] V0.3.4 - UniChem (cycle 22 PR-CORE-2 cursor)');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonlStrict(file);
    console.log(`[ID-RESOLVER] Loaded ${compounds.length} compounds`);

    // PR-FDA-SRS-2c one-time bootstrap: backfill unichem_matched on existing
    // records with prior UniChem evidence. Subsequent cycles skip already-flagged.
    const bootstrapped = bootstrapUnichemMatchedFlag(compounds);
    if (bootstrapped > 0) console.log(`[ID-RESOLVER] Bootstrap backfilled unichem_matched=true on ${bootstrapped} historical records (Option E PR-FDA-SRS-2c)`);

    const eligible = compounds.filter(isEligible);
    console.log(`[ID-RESOLVER] Eligible (inchi_key present, not yet UniChem-stamped): ${eligible.length}`);

    if (eligible.length === 0) {
        console.log('[ID-RESOLVER] Nothing to do - all compounds already UniChem-stamped or lack inchi_key.');
        return;
    }

    let cursor = null;
    try { cursor = await readCursor(SOURCE); }
    catch (err) { console.warn(`[ID-RESOLVER] Cursor read failed (${err.message}) - starting fresh`); }
    const chunkSize = cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    console.log(`[ID-RESOLVER] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | budget=${(DRAIN_BUDGET_MS / 60000).toFixed(1)}min | coldStart=${(COLD_START_MS / 60000).toFixed(1)}min`);

    // V5 drain-until-cleared: keep consuming chunks until corpus wraps,
    // EWMA budget gate fires, or eligible is empty. Helper mutates eligible
    // records in place (shared object refs with `compounds`); no per-chunk
    // I/O. Terminal commit happens AFTER drainAdapterBacklog returns.
    const drain = await drainAdapterBacklog({
        eligible, enrichOne, chunkIterator, chunkSize,
        timeBudgetMs: DRAIN_BUDGET_MS, coldStartEstimateMs: COLD_START_MS,
        sleepMsBetween: UNICHEM_DELAY, initialCursor: cursor,
        logPrefix: '[ID-RESOLVER]', logEveryNRecords: 100,
    });
    console.log(`[ID-RESOLVER] Drain done | terminatedBy=${drain.terminatedBy} | chunksDrained=${drain.chunksDrained} | processedInRun=${drain.processedInRun} | remainingBacklog=${drain.remainingBacklog}`);

    // Compute domain-specific hit counters from the mutated master AFTER drain.
    // hit = compounds with unichem in sources; withUnii = compounds with UNII id.
    // Done in one pass so we don't double-iterate just for telemetry.
    let hit = 0, withUnii = 0;
    for (const rec of compounds) {
        if (rec.external_ids?.sources?.includes('unichem')) hit++;
        if (rec.external_ids?.unii) withUnii++;
    }

    // Terminal atomic commit (V5 architect-locked): streaming local write
    // then single cursor PUT to R2. If GHA aborts before this point, R2
    // cursor stays at OLD value and next cycle re-runs the drain idempotently
    // (isEligible filters out anything that did get committed via prior cycles).
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
            console.log(`[ID-RESOLVER] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
        } catch (err) {
            console.error(`[ID-RESOLVER] Cursor write failed: ${err.message}`);
            throw err;
        }
    } else {
        console.log('[ID-RESOLVER] No chunks drained (empty eligible at entry) -- cursor unchanged');
    }

    console.log(`\n[ID-RESOLVER] Complete - this cycle: ${hit} UniChem stamps | ${withUnii} UNII gained`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[ID-RESOLVER] Fatal:', err); process.exit(1); });
}
