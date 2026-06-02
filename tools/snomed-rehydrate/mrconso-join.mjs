/**
 * Dependency-free local MRCONSO.RRF reader -> SNOMED concept collapse -> sid_s map.
 *
 * MIRRORS scripts/factory/lib/umls-concept-streams.js (atomRank + ingestMrconsoRow
 * collapse, EXACT SAB=SNOMEDCT_US + SUPPRESS=N + LAT=ENG filters) and
 * scripts/factory/lib/rxnorm-rrf-streams.js makeRrfParser (pipe-delimited,
 * relax_column_count: the trailing pipe yields an empty 19th segment we ignore).
 *
 * Vendored (NOT imported) so the tool is dependency-free + trivially auditable:
 *   - splitRrfLine: a ~10-line pipe-splitter replacing csv-parse.
 *   - atomRank / collapse: identical precedence to the pipeline so the rehydrated
 *     preferred_str / synonyms match what Sciweon stamped.
 *
 * Reads ONLY the researcher's OWN licensed MRCONSO.RRF. Ships ZERO SNOMED content.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { sidS } from './sid-derive.mjs';

// MRCONSO column order -- verified pipeline constant (umls-concept-streams.js).
export const MRCONSO_COLUMNS = [
    'CUI', 'LAT', 'TS', 'LUI', 'STT', 'SUI', 'ISPREF', 'AUI', 'SAUI', 'SCUI',
    'SDUI', 'SAB', 'TTY', 'CODE', 'STR', 'SRL', 'SUPPRESS', 'CVF',
];

export const SNOMED_SAB = 'SNOMEDCT_US';

/**
 * Split one raw RRF line into a named-field object. Pipe-delimited; each line
 * carries a TRAILING pipe -> 19 segments, the 19th empty (absorbed by mapping
 * only the 18 named columns). Mirrors makeRrfParser(relax_column_count:true).
 */
export function splitRrfLine(line) {
    const parts = line.split('|');
    const row = {};
    for (let i = 0; i < MRCONSO_COLUMNS.length; i++) {
        row[MRCONSO_COLUMNS[i]] = parts[i] ?? '';
    }
    return row;
}

// Preferred-atom precedence -- vendored verbatim from umls-concept-streams.js
// atomRank. LOWER rank = MORE preferred; rank 4 = first-seen fallback (never drop).
export function atomRank(row) {
    if (row.ISPREF === 'Y' && row.TS === 'P' && row.STT === 'PF') return 1;
    if (row.ISPREF === 'Y' && row.TS === 'P') return 2;
    if (row.TS === 'P') return 3;
    return 4;
}

/**
 * Ingest one parsed MRCONSO row into a byCode accumulator. EXACT SAB=SNOMEDCT_US +
 * SUPPRESS=N + LAT=ENG (mirrors ingestMrconsoRow harvest branch). Collapses atoms
 * to one concept per distinct CODE; old preferred string demotes to a synonym.
 */
export function ingestSnomedRow(byCode, row) {
    if (!row || row.SAB !== SNOMED_SAB) return byCode;
    if (row.SUPPRESS !== 'N') return byCode;
    if (row.LAT !== 'ENG') return byCode;
    const code = row.CODE;
    if (!code) return byCode;

    const str = row.STR ?? '';
    const rank = atomRank(row);
    const existing = byCode.get(code);
    if (!existing) {
        byCode.set(code, { code, preferredRank: rank, preferred_str: str, synonyms: new Set() });
        return byCode;
    }
    if (rank < existing.preferredRank) {
        if (existing.preferred_str && existing.preferred_str !== str) {
            existing.synonyms.add(existing.preferred_str);
        }
        existing.preferredRank = rank;
        existing.preferred_str = str;
        existing.synonyms.delete(str);
    } else if (str && str !== existing.preferred_str) {
        existing.synonyms.add(str);
    }
    return byCode;
}

/**
 * Finalize the accumulator into a Map keyed by the locally re-derived sid_s.
 * Each value = { code, preferred_str, synonyms[] } (synonyms sorted). The key is
 * sidS(code) so a join against Sciweon's published sid_s recovers CODE + STR.
 */
export function buildSidMap(byCode) {
    const bySidS = new Map();
    let collisions = 0;
    for (const entry of byCode.values()) {
        const key = sidS(entry.code);
        if (bySidS.has(key)) { collisions++; continue; }
        bySidS.set(key, {
            code: entry.code,
            preferred_str: entry.preferred_str,
            synonyms: [...entry.synonyms].sort(),
        });
    }
    return { bySidS, collisions };
}

/**
 * Stream a local MRCONSO.RRF and build sid_s -> {code, preferred_str, synonyms[]}.
 * Streaming (readline), never buffer-loads the multi-GB file.
 * @returns {Promise<{ bySidS: Map, rows_total, snomed_rows_kept, distinct_codes, collisions }>}
 */
export async function buildSidMapFromMrconso(mrconsoPath) {
    const byCode = new Map();
    let rowsTotal = 0;
    let snomedRowsKept = 0;
    const stream = createReadStream(mrconsoPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line) continue;
        rowsTotal++;
        const row = splitRrfLine(line);
        const before = byCode.size;
        ingestSnomedRow(byCode, row);
        if (row.SAB === SNOMED_SAB && row.SUPPRESS === 'N' && row.LAT === 'ENG' && row.CODE) {
            snomedRowsKept++;
        }
        void before;
    }
    const { bySidS, collisions } = buildSidMap(byCode);
    return {
        bySidS,
        rows_total: rowsTotal,
        snomed_rows_kept: snomedRowsKept,
        distinct_codes: byCode.size,
        collisions,
    };
}
