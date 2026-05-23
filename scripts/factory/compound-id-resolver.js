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

import fs from 'fs/promises';
import path from 'path';
import { fetchByInchiKey, REQUEST_DELAY_MS as UNICHEM_DELAY } from '../ingestion/adapters/unichem-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';

const SOURCE = 'unichem';
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
    record.external_ids = external;
    return record;
}

async function main() {
    console.log('[ID-RESOLVER] V0.3.4 - UniChem (cycle 22 PR-CORE-2 cursor)');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[ID-RESOLVER] Loaded ${compounds.length} compounds`);

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
    const { slice, nextCursorId, wrapped, totalEligible } = chunkIterator(eligible, cursor, chunkSize);

    console.log(`[ID-RESOLVER] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | slice=${slice.length} | wrapped=${wrapped}`);

    let hit = 0;
    let processed = 0;
    let withUnii = 0;
    for (const rec of slice) {
        await enrichOne(rec);
        if (rec.external_ids?.sources?.includes('unichem')) hit++;
        if (rec.external_ids?.unii) withUnii++;
        processed++;
        if (processed % 100 === 0 || processed === slice.length) {
            console.log(`[ID-RESOLVER] ${processed}/${slice.length} | UniChem hit: ${hit} | UNII: ${withUnii}`);
        }
        await sleep(UNICHEM_DELAY);
    }

    await writeJsonl(file, compounds);

    const nextCursor = buildNextCursor({
        source: SOURCE, prev: cursor,
        chunkResult: { slice, nextCursorId, wrapped, totalEligible },
        processedCount: processed, totalEligible,
    });
    try {
        await writeCursor(SOURCE, nextCursor);
        console.log(`[ID-RESOLVER] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
    } catch (err) {
        console.error(`[ID-RESOLVER] Cursor write failed: ${err.message}`);
        throw err;
    }

    console.log(`\n[ID-RESOLVER] Complete - this cycle: ${hit} UniChem stamps | ${withUnii} UNII gained`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[ID-RESOLVER] Fatal:', err); process.exit(1); });
}
