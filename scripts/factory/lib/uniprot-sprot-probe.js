/**
 * PR-UNIPROT-0: pure helpers for the UniProt SwissProt diagnostic row-dump probe.
 * No network / no I/O -- unit-testable. The probe script
 * (diagnostic-uniprot-sprot-probe.js) wraps these with the anonymous HTTPS
 * stream of uniprot_sprot.dat.gz (gunzip-aware, via stream-fetch-retry.js).
 *
 * DIAGNOSTIC ONLY, per [[external_dataset_diagnostic_first]]: these helpers DUMP +
 * MEASURE raw .dat record blocks so the real EMBL/SwissProt line-code -> value map
 * is VERIFIED against data before any ingest parser is written. They are explicitly
 * NOT the production ingest parser (PR-UNIPROT-1 builds that from the field map this
 * probe verifies). The TENTATIVE extractions below are doc-derived candidates flagged
 * for reviewer confirmation, never trusted as schema truth.
 */

// SwissProt .dat record delimiter line ("//" on its own line ends every entry).
export const RECORD_DELIMITER = '//';

// REST baselines to FLAG drift against (NOT to assert -- the probe MEASURES from the
// rows and prints drift). SwissProt entry total + per-organism (Homo sapiens 9606 /
// Mus musculus 10090 / Rattus norvegicus 10116) are point-in-time references.
export const REST_TOTAL_BASELINE = 574627;
export const REST_TAXON_BASELINE = { 9606: 20431, 10090: 17252, 10116: 8226 };
export const TARGET_TAXA = [9606, 10090, 10116];

/**
 * splitRecordBlocks -- split a chunk of .dat text into COMPLETE record blocks on the
 * "//" delimiter line. Pure + stateful-safe: returns { blocks, remainder } so a
 * streaming caller carries `remainder` forward to the next chunk (a record may span
 * chunk boundaries). A block is the verbatim text BETWEEN delimiters (the lines of one
 * entry, delimiter line itself excluded). Trailing text with no closing "//" stays in
 * remainder (never emitted as a block -- a half record is not a record).
 *
 * @param {string} text     incoming text (prior remainder already prepended by caller)
 * @returns {{blocks: string[], remainder: string}}
 */
export function splitRecordBlocks(text) {
    const blocks = [];
    const lines = String(text ?? '').split('\n');
    let cur = [];
    let lastDelimLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.replace(/\r$/, '') === RECORD_DELIMITER) {
            blocks.push(cur.join('\n'));
            cur = [];
            lastDelimLineIdx = i;
        } else {
            cur.push(line);
        }
    }
    // Everything after the last "//" delimiter is an incomplete record -> remainder.
    const remainder = lastDelimLineIdx < 0
        ? String(text ?? '')
        : lines.slice(lastDelimLineIdx + 1).join('\n');
    return { blocks, remainder };
}

/** True iff `block` contains at least one non-blank, non-delimiter line. */
export function isNonEmptyBlock(block) {
    return /\S/.test(String(block ?? '')) && String(block).trim() !== RECORD_DELIMITER;
}

/**
 * extractFieldMapTentative -- TENTATIVE (probe diagnostic, NOT the ingest parser)
 * candidate value per EMBL/SwissProt line code, so a reviewer confirms WHICH line
 * holds each field. Doc-derived candidates only; never trusted as the production map.
 *
 * Line codes (SwissProt .dat):
 *   ID  -> sequence_length    the "NNN AA." token on the ID line
 *   AC  -> primary_accession  first ;-delimited token on the first AC line
 *   DE RecName: Full=         recommended full name
 *   DE  ... EC=               EC number (if present)
 *   GN  Name=                 primary gene name
 *   OS  -> organism           scientific name (OS line text, trailing '.' stripped)
 *   OX  NCBI_TaxID=NNNN       NCBI taxonomy id
 *   SQ  -> seq_length / MW    "SEQUENCE NNN AA; MMMM MW;" tokens
 *
 * @param {string} block   one record block (delimiter excluded)
 * @returns {object}       { id_len, accession, de_full, ec, gene, organism, taxid, sq_len, sq_mw }
 */
export function extractFieldMapTentative(block) {
    const lines = String(block ?? '').split('\n');
    const out = {
        id_len: null, accession: null, de_full: null, ec: null,
        gene: null, organism: null, taxid: null, sq_len: null, sq_mw: null,
    };
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const code = line.slice(0, 2);
        const body = line.slice(5); // EMBL line code is cols 1-2, then 3 spaces, then body
        if (code === 'ID' && out.id_len === null) {
            const m = line.match(/\b(\d+)\s+AA\.?/);
            if (m) out.id_len = Number(m[1]);
        } else if (code === 'AC' && out.accession === null) {
            const first = body.split(';')[0].trim();
            if (first) out.accession = first;
        } else if (code === 'DE') {
            if (out.de_full === null) {
                const m = line.match(/RecName:\s*Full=([^;{]+)/);
                if (m) out.de_full = m[1].trim();
            }
            if (out.ec === null) {
                const m = line.match(/EC=([0-9.\-n]+)/);
                if (m) out.ec = m[1].trim();
            }
        } else if (code === 'GN' && out.gene === null) {
            const m = line.match(/Name=([^;{]+)/);
            if (m) out.gene = m[1].trim();
        } else if (code === 'OS' && out.organism === null) {
            const t = body.trim().replace(/\.$/, '');
            if (t) out.organism = t;
        } else if (code === 'OX' && out.taxid === null) {
            const t = parseTaxId(line);
            if (t !== null) out.taxid = t;
        } else if (code === 'SQ') {
            const ml = line.match(/SEQUENCE\s+(\d+)\s+AA/);
            if (ml && out.sq_len === null) out.sq_len = Number(ml[1]);
            const mw = line.match(/;\s*(\d+)\s+MW/);
            if (mw && out.sq_mw === null) out.sq_mw = Number(mw[1]);
        }
    }
    return out;
}

/**
 * parseTaxId -- extract the NCBI_TaxID from one OX line ("OX   NCBI_TaxID=9606;" or
 * "OX   NCBI_TaxID=9606 {ECO:...};"). Returns the integer taxid, or null when the line
 * has no parseable NCBI_TaxID (the silent-drop guard: a null here is COUNTED, never
 * dropped). Accepts either a full OX line or just its body.
 *
 * @param {string} oxLine
 * @returns {number|null}
 */
export function parseTaxId(oxLine) {
    const m = String(oxLine ?? '').match(/NCBI_TaxID=(\d+)/);
    return m ? Number(m[1]) : null;
}

/** Fresh per-target-taxon tally (+ other + no_ox) for a streaming pass. */
export function newTaxonTally() {
    return { 9606: 0, 10090: 0, 10116: 0, other: 0, no_ox: 0 };
}

/**
 * tallyTaxon -- tally ONE record block's organism into the running taxon tally by its
 * OX NCBI_TaxID. A block with NO parseable OX line increments `no_ox` (the silent-drop
 * guard -- such a record is COUNTED, never silently lost). Pure (mutates + returns the
 * passed tally).
 *
 * @param {object} tally   from newTaxonTally()
 * @param {string} block   one record block
 * @returns {object}       the same tally, mutated
 */
export function tallyTaxon(tally, block) {
    const lines = String(block ?? '').split('\n');
    let taxid = null;
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line.slice(0, 2) === 'OX') { taxid = parseTaxId(line); break; }
    }
    if (taxid === null) { tally.no_ox += 1; return tally; }
    if (taxid === 9606 || taxid === 10090 || taxid === 10116) tally[taxid] += 1;
    else tally.other += 1;
    return tally;
}

/** Fresh DR-source distribution accumulator (xref source -> count). */
export function newDrSourceTally() {
    return new Map();
}

/**
 * tallyDrSources -- accumulate this block's DR (database cross-reference) line source
 * types into the running Map (source -> count). The DR line shape is
 * "DR   <SOURCE>; <id>; ...;" -- the first ;-delimited token is the source type. Pure
 * (mutates + returns the Map).
 *
 * @param {Map<string,number>} tally
 * @param {string} block
 * @returns {Map<string,number>}
 */
export function tallyDrSources(tally, block) {
    const lines = String(block ?? '').split('\n');
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line.slice(0, 2) !== 'DR') continue;
        const src = line.slice(5).split(';')[0].trim();
        if (src) tally.set(src, (tally.get(src) || 0) + 1);
    }
    return tally;
}

/**
 * hasCcByLicense -- diagnostic CC BY 4.0 presence check over a record block's CC lines.
 * SwissProt stamps the distribution license in a CC block:
 *   "CC   -----------------------------------------------------------------------"
 *   "CC   Copyrighted by the UniProt Consortium ... Distributed under the Creative"
 *   "CC   Commons Attribution (CC BY 4.0) License"
 * Returns true iff the block's CC text mentions the CC BY 4.0 Creative Commons license.
 *
 * @param {string} block
 * @returns {boolean}
 */
export function hasCcByLicense(block) {
    const ccText = String(block ?? '')
        .split('\n')
        .filter((l) => l.replace(/\r$/, '').slice(0, 2) === 'CC')
        .map((l) => l.replace(/\r$/, '').slice(5))
        .join(' ');
    return /Creative\s+Commons\s+Attribution\s*\(CC\s*BY\s*4\.0\)/i.test(ccText)
        || /\bCC\s*BY\s*4\.0\b/i.test(ccText);
}

/** Top-N (source,count) entries of a DR-source Map, descending by count then name. */
export function topDrSources(tally, n = 30) {
    return [...tally.entries()]
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, n);
}
