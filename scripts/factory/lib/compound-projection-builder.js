/**
 * Compound projection builder — PR-COMPOUND-GUARD (Step-5a).
 *
 * Streams ./output/linked/compounds-enriched.jsonl ONCE (readline) and emits
 * two SERVING projections so the worker never whole-file-scans the (uncapped,
 * fda_signals-bearing) enriched file inside the 128MB isolate:
 *
 *   1. compounds-search.jsonl  -- one compact JSON/line (CID-asc) carrying
 *      EXACTLY the union of fields scoreMatch + summarize read in compound-
 *      search.ts, in their NESTED shapes (molecular_weight.value,
 *      drug_status.max_phase, confidence.overall) so those functions run
 *      BYTE-IDENTICALLY against a projection record. EXCLUDES fda_signals
 *      (unused) -> the projection is INVARIANT under the FDA preserve-all uncap.
 *
 *   2. xref-index.json  -- a GLOBAL index over ALL 7 non-CID id kinds
 *      (chembl_id, inchi_key, unii, drugbank_id, chebi_id, kegg_drug_id, rxcui)
 *      partitioned BY KIND so the worker loads ONLY the queried kind's Map
 *      (xref-index-loader.ts). Keys = the NORMALIZED form from
 *      classifyIdentifier (entity-resolver.ts). First/lowest CID wins on an
 *      id->multiple-cid collision (matches the prior first-match scan) + a
 *      build-time WARN count. The CID kind is NOT indexed (the resolver fast
 *      path never reads the file).
 *
 * NO SILENT DROP ([[cross_cycle_silent_data_loss]]): reuses the malformed /
 * non-numeric-cid counting from compound-shard-publisher.js#readCompoundsInOrder
 * -- a dropped record is a LOUD throw, never a silent gap.
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';

const LINKED_DIR = './output/linked';
const ENRICHED_FILE = 'compounds-enriched.jsonl';
export const SEARCH_PROJECTION_FILE = 'compounds-search.jsonl';
export const XREF_INDEX_FILE = 'xref-index.json';

// The 7 non-CID id kinds, each mapped to a build-time normalizer mirroring
// classifyIdentifier (entity-resolver.ts:55-74). The reader extracts the raw
// value, the normalizer canonicalizes it (uppercase / CHEBI: / bare rxcui).
const KINDS = ['chembl_id', 'inchi_key', 'unii', 'drugbank_id', 'chebi_id', 'kegg_drug_id', 'rxcui'];

function upper(v) { return String(v).toUpperCase(); }
function chebiNorm(v) {
    const m = String(v).match(/^CHEBI:(\d+)$/i);
    return m ? `CHEBI:${m[1]}` : null;
}
function rxcuiNorm(v) {
    const m = String(v).match(/^(?:RXCUI:)?(\d+)$/i);
    return m ? m[1] : null;
}
const NORMALIZERS = {
    chembl_id: upper, inchi_key: upper, unii: upper, drugbank_id: upper,
    kegg_drug_id: upper, chebi_id: chebiNorm, rxcui: rxcuiNorm,
};

// Read the raw id value for a kind off a compound record (the exact fields
// matchOnField checks: top-level chembl_id/inchi_key; external_ids.* otherwise).
function rawIdFor(rec, kind) {
    if (kind === 'chembl_id') return rec.chembl_id;
    if (kind === 'inchi_key') return rec.inchi_key;
    const ext = rec.external_ids || {};
    return ext[kind];
}

// The compact search record: EXACTLY the union scoreMatch + summarize read.
function toSearchRecord(rec) {
    const mw = rec.molecular_weight && typeof rec.molecular_weight === 'object'
        ? { value: rec.molecular_weight.value ?? null } : null;
    const ds = rec.drug_status && typeof rec.drug_status === 'object'
        ? { max_phase: rec.drug_status.max_phase ?? null } : null;
    const conf = rec.confidence && typeof rec.confidence === 'object'
        ? { overall: rec.confidence.overall ?? null } : null;
    return {
        id: rec.id,
        pubchem_cid: rec.pubchem_cid,
        chembl_id: rec.chembl_id ?? null,
        synonyms: Array.isArray(rec.synonyms) ? rec.synonyms : [],
        iupac_name: rec.iupac_name ?? null,
        molecular_formula: rec.molecular_formula ?? null,
        molecular_weight: mw,
        drug_status: ds,
        confidence: conf,
    };
}

/**
 * Build both projections. Returns { searchPath, xrefPath, total, collisions }.
 * Throws LOUD on any dropped record (malformed line / non-numeric cid).
 */
export async function buildProjections({ inputDir = LINKED_DIR, outputDir = LINKED_DIR } = {}) {
    const inputPath = path.join(inputDir, ENRICHED_FILE);
    const searchPath = path.join(outputDir, SEARCH_PROJECTION_FILE);
    const xrefPath = path.join(outputDir, XREF_INDEX_FILE);

    // index[kind][normalized] = cid (first/lowest CID wins). search rows buffered
    // for a CID-asc sort (mirrors the publisher; the corpus is ~130K compounds).
    const index = Object.create(null);
    for (const k of KINDS) index[k] = Object.create(null);
    const searchRows = [];
    let skippedMalformed = 0;
    let skippedNonNumericCid = 0;
    let collisions = 0;

    const rl = readline.createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); }
        catch { skippedMalformed++; continue; }
        const cid = rec.pubchem_cid;
        if (typeof cid !== 'number') { skippedNonNumericCid++; continue; }

        searchRows.push(toSearchRecord(rec));
        for (const kind of KINDS) {
            const raw = rawIdFor(rec, kind);
            if (raw == null || raw === '') continue;
            const norm = NORMALIZERS[kind](raw);
            if (!norm) continue;
            const existing = index[kind][norm];
            if (existing === undefined) {
                index[kind][norm] = cid;
            } else if (cid < existing) {
                // first-match scan kept the LOWEST CID (CID-asc); preserve that.
                index[kind][norm] = cid;
                collisions++;
            } else if (cid > existing) {
                collisions++;
            }
        }
    }

    if (skippedMalformed + skippedNonNumericCid > 0) {
        throw new Error(`[COMPOUND-PROJECTION] refusing to emit: ${skippedMalformed + skippedNonNumericCid} records dropped `
            + `(malformed=${skippedMalformed}, nonNumericCid=${skippedNonNumericCid}) -- silent gap [[cross_cycle_silent_data_loss]]`);
    }

    searchRows.sort((a, b) => a.pubchem_cid - b.pubchem_cid);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(searchPath, searchRows.map(r => JSON.stringify(r)).join('\n') + (searchRows.length ? '\n' : ''));

    const xref = {
        version: '1.0',
        snapshot_date: process.env.TARGET_DATE || new Date().toISOString().slice(0, 10),
        generated_at: new Date().toISOString(),
        total_compounds: searchRows.length,
        index,
    };
    await fs.writeFile(xrefPath, JSON.stringify(xref));

    if (collisions > 0) {
        console.warn(`[COMPOUND-PROJECTION] ${collisions} id->multiple-cid collisions (kept lowest CID, first-match parity)`);
    }
    console.log(`[COMPOUND-PROJECTION] ${searchRows.length} compounds -> ${SEARCH_PROJECTION_FILE} + ${XREF_INDEX_FILE} `
        + `(7-kind xref index, ${collisions} collisions)`);
    return { searchPath, xrefPath, total: searchRows.length, collisions };
}

async function main() {
    await buildProjections({});
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
    main().catch(err => { console.error('[COMPOUND-PROJECTION] Fatal:', err); process.exit(1); });
}
