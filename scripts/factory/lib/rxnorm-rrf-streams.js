/**
 * RxNorm RRF table stream loaders (PR-RXN-1 lib).
 *
 * Three-phase sequential loaders for RXNREL / RXNCONSO / RXNSAT tables
 * from the prescribable subset ZIP. Each function consumes a single
 * RRF entry and returns a built-in-memory structure. Callers MUST
 * await each phase before the next per LOCK 1 (sequential ordering).
 *
 * RRF tables are pipe-delimited and shipped without header rows;
 * column positions defined by NLM Technical Documentation are
 * encoded as constants here (single SSoT).
 */

import { parse as parseCsv } from 'csv-parse';
import { normalizeNdcTo11Digit } from './ndc-normalize.js';
import { buildProductToIngredientsMap } from './rxnorm-rel-projector.js';

export const RXNCONSO_COLUMNS = ['RXCUI', 'LAT', 'TS', 'LUI', 'STT', 'SUI', 'ISPREF', 'RXAUI', 'SAUI', 'SCUI', 'SDUI', 'SAB', 'TTY', 'CODE', 'STR', 'SRL', 'SUPPRESS', 'CVF'];

// PR-RXN-1f: NLM canonical UNII shape (10-char uppercase alphanumeric).
// Single SSoT for the shape regex; diagnostic-rxnorm-mthspl.js + harvester
// both import this so the gate cannot drift between probe and production.
// Verified against 11,245 / 11,246 (99.99%) MTHSPL/SU CODE values in
// diagnostic run 26612396344 (release=2026-05-04).
export const UNII_SHAPE = /^[A-Z0-9]{10}$/;
export function isCanonicalUnii(s) {
    return typeof s === 'string' && UNII_SHAPE.test(s);
}
// PR-RXN-1 column-order hotfix 2026-05-27: empirical row-dump from run
// 26506247880 proved actual RXNSAT.RRF order is ... ATN, SAB, ATV, ...
// (SAB precedes ATV), contradicting the UMLS Metathesaurus MRSAT column
// doc and pre-empirical Phase 1 research notes. Locked from real data.
export const RXNSAT_COLUMNS = ['RXCUI', 'LUI', 'SUI', 'RXAUI', 'STYPE', 'CODE', 'ATUI', 'SATUI', 'ATN', 'SAB', 'ATV', 'SUPPRESS', 'CVF'];
export const RXNREL_COLUMNS = ['RXCUI1', 'RXAUI1', 'STYPE1', 'REL', 'RXCUI2', 'RXAUI2', 'STYPE2', 'RELA', 'RUI', 'SRUI', 'SAB', 'SL', 'DIR', 'RG', 'SUPPRESS', 'CVF'];

function makeRrfParser(columns) {
    return parseCsv({
        delimiter: '|', columns, trim: false, relax_quotes: true, relax_column_count: true,
        skip_empty_lines: true,
    });
}

// Resolve RRF entry tolerating optional rrf/ subdirectory layout.
export function findRrfEntry(entries, filename) {
    return Object.values(entries).find(e => !e.isDirectory && new RegExp(`(^|/)${filename}$`, 'i').test(e.name));
}

// LOCK 1 Phase 1: parse RXNREL.RRF, build product -> Set<ingredient>.
export async function loadProductToIngredients(zip) {
    const entries = await zip.entries();
    const target = findRrfEntry(entries, 'RXNREL.RRF');
    if (!target) throw new Error('RXNREL.RRF entry not found in ZIP');
    const rows = [];
    const stream = await zip.stream(target.name);
    const parser = stream.pipe(makeRrfParser(RXNREL_COLUMNS));
    for await (const row of parser) rows.push(row);
    return buildProductToIngredientsMap(rows);
}

// LOCK 1 Phase 2: parse RXNCONSO.RRF.
//
// Builds (a) canonical rxcui -> {preferred_str, tty, sab} meta map under
// the standard SAB=RXNORM + LAT=ENG filter (unchanged contract), and
// (b) PR-RXN-1f MTHSPL UNII rewire: parallel rxcui -> UNII map harvested
// from SAB=MTHSPL + TTY=SU rows whose CODE matches the canonical UNII
// shape. Both maps built in a single stream pass (zero extra I/O).
//
// Returns { meta, mthsplUniiByRxcui, mthsplTelemetry } where telemetry =
// { total_mthspl_conso_rows, mthspl_su_rows, mthspl_unii_harvested,
//   mthspl_unii_dropped_shape }.
export async function loadRxcuiMeta(zip) {
    const entries = await zip.entries();
    const target = findRrfEntry(entries, 'RXNCONSO.RRF');
    if (!target) throw new Error('RXNCONSO.RRF entry not found in ZIP');
    const meta = new Map();
    const mthsplUniiByRxcui = new Map();
    const mthsplTelemetry = {
        total_mthspl_conso_rows: 0,
        mthspl_su_rows: 0,
        mthspl_unii_harvested: 0,
        mthspl_unii_dropped_shape: 0,
    };
    const stream = await zip.stream(target.name);
    const parser = stream.pipe(makeRrfParser(RXNCONSO_COLUMNS));
    for await (const row of parser) {
        if (row.SUPPRESS && row.SUPPRESS !== 'N') continue;

        // PR-RXN-1f parallel branch: MTHSPL UNII extraction. Diagnostic
        // (run 26612396344) confirmed TTY=SU rows carry FDA UNII at
        // 99.99% rate; hard regex guard rejects the rare malformed.
        // First-write-wins because duplicate-language rows share the
        // same CODE per the same diagnostic. Runs alongside the canonical
        // meta filter without sharing exit; MTHSPL rows never reach
        // meta.set since the canonical filter requires SAB=RXNORM.
        if (row.SAB === 'MTHSPL') {
            mthsplTelemetry.total_mthspl_conso_rows++;
            if (row.TTY === 'SU') {
                mthsplTelemetry.mthspl_su_rows++;
                const code = (row.CODE ?? '').trim().toUpperCase();
                if (isCanonicalUnii(code)) {
                    if (!mthsplUniiByRxcui.has(row.RXCUI)) {
                        mthsplUniiByRxcui.set(row.RXCUI, code);
                    }
                    mthsplTelemetry.mthspl_unii_harvested++;
                } else {
                    mthsplTelemetry.mthspl_unii_dropped_shape++;
                }
            }
        }

        if (row.LAT !== 'ENG') continue;
        if (row.SAB !== 'RXNORM') continue;
        const existing = meta.get(row.RXCUI);
        const isCanonical = row.TS === 'P' && row.ISPREF === 'Y';
        if (!existing || (isCanonical && !existing.is_canonical)) {
            meta.set(row.RXCUI, {
                preferred_str: row.STR,
                tty: row.TTY,
                sab: row.SAB,
                is_canonical: isCanonical,
            });
        }
    }
    return { meta, mthsplUniiByRxcui, mthsplTelemetry };
}

// LOCK 1 Phase 3: parse RXNSAT.RRF; project NDC -> ingredient via
// Phase 1 map; attach UNII directly to its row's RxCUI (ingredient-level
// by RxNorm convention). Returns Map<ingredientRxcui, { unii?, ndcs: Set }>.
// SAB filter: SAB='RXNORM' guarantees HIPAA-normalized 11-digit NDC per NLM
// tech docs. Other SABs (MTHSPL/FDB/MULTUM/MMSL) emit varied formats (12-digit
// '6-4-2', 10-digit '5-3-2'/'4-4-2'/'5-4-1') and would all reject under LOCK 2.
// V1 scope is canonical SAB=RXNORM only; PR-RXN-2 may expand if multi-SAB
// coverage justifies the per-SAB normalization complexity.
const NDC_ACCEPTED_SABS = new Set(['RXNORM']);

export async function loadIngredientAttributes(zip, productToIngredients, droppedCounts) {
    const entries = await zip.entries();
    const target = findRrfEntry(entries, 'RXNSAT.RRF');
    if (!target) throw new Error('RXNSAT.RRF entry not found in ZIP');
    const attrs = new Map();
    const stream = await zip.stream(target.name);
    const parser = stream.pipe(makeRrfParser(RXNSAT_COLUMNS));

    function ensureRecord(rxcui) {
        if (!attrs.has(rxcui)) attrs.set(rxcui, { unii: null, ndcs: new Set() });
        return attrs.get(rxcui);
    }

    // Ops-visibility sample of rejected NDC values (first 10 unique).
    const droppedSamples = new Set();
    function recordDropSample(value) {
        if (droppedSamples.size >= 10) return;
        droppedSamples.add(value);
    }

    // Diagnostic: distribution of SABs observed on NDC rows, for ops visibility.
    const ndcSabCounts = new Map();

    for await (const row of parser) {
        if (row.SUPPRESS && row.SUPPRESS !== 'N') continue;
        if (row.ATN !== 'UNII' && row.ATN !== 'NDC') continue;
        const rxcui = row.RXCUI;
        const value = (row.ATV ?? '').trim();
        if (!rxcui || !value) continue;

        if (row.ATN === 'UNII') {
            ensureRecord(rxcui).unii = value;
        } else {
            ndcSabCounts.set(row.SAB, (ndcSabCounts.get(row.SAB) || 0) + 1);
            // NDC: filter to SAB='RXNORM' so LOCK 2 11-digit regex matches the
            // NLM-normalized format. Non-RXNORM SAB rows have varied formats
            // and are counted in dropped_counts.skipped_nonrxnorm_sab.
            if (!NDC_ACCEPTED_SABS.has(row.SAB)) {
                droppedCounts.skipped_nonrxnorm_sab = (droppedCounts.skipped_nonrxnorm_sab || 0) + 1;
                continue;
            }
            const normalized = normalizeNdcTo11Digit(value);
            if (!normalized) {
                droppedCounts.malformed_ndc++;
                recordDropSample(value);
                continue;
            }
            const ingredients = productToIngredients.get(rxcui);
            const targets = (ingredients && ingredients.size > 0) ? ingredients : [rxcui];
            for (const ing of targets) ensureRecord(ing).ndcs.add(normalized);
        }
    }
    droppedCounts.malformed_ndc_samples = [...droppedSamples];
    droppedCounts.ndc_sab_distribution = Object.fromEntries(ndcSabCounts);
    return attrs;
}

/**
 * Join phase outputs into final ingredient-keyed records. One record per
 * ingredient-level RxCUI carrying any UNII or NDC association.
 *
 * PR-RXN-1f: 3rd parameter `mthsplUniiByRxcui` provides the MTHSPL/SU
 * Prescribable-internal UNII fallback. Precedence: attr.unii (Full Release
 * RXNSAT path, currently empty under Prescribable) > mthsplUniiByRxcui.
 * Iterates the union of attrs.keys() + mthsplUniiByRxcui.keys() so RxCUIs
 * carrying only MTHSPL UNII (no NDC) are also emitted -- expanding the
 * artifact from the 7,573 NDC-only baseline to roughly ~17K including
 * MTHSPL-UNII-only ingredients. Output stays lex-sorted by rxcui.
 */
export function composeRecords(meta, attrs, mthsplUniiByRxcui = new Map()) {
    const out = [];
    const allRxcuis = new Set([...attrs.keys(), ...mthsplUniiByRxcui.keys()]);
    for (const rxcui of allRxcuis) {
        const attr = attrs.get(rxcui) ?? { unii: null, ndcs: new Set() };
        const unii = attr.unii ?? mthsplUniiByRxcui.get(rxcui) ?? null;
        if (!unii && attr.ndcs.size === 0) continue;
        const m = meta.get(rxcui) ?? {};
        out.push({
            rxcui,
            preferred_str: m.preferred_str ?? null,
            tty: m.tty ?? null,
            sab: m.sab ?? null,
            unii,
            ndcs: [...attr.ndcs].sort(),
        });
    }
    out.sort((a, b) => a.rxcui.localeCompare(b.rxcui));
    return out;
}
