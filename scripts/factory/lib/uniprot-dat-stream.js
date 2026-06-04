/**
 * UniProt SwissProt (.dat) streaming parser lib (PR-UNIPROT-1).
 *
 * PURE + streaming, unit-tested. The HARDENED production parser built FROM the
 * PR-UNIPROT-0 probe's VERIFIED .dat field map (run 26934783552, release 2026_01,
 * 574,627 //-records, CC BY 4.0 on every record, no_ox=0). splitRecordBlocks is
 * reused VERBATIM from lib/uniprot-sprot-probe.js for chunk-boundary safety; this
 * module adds `parseUniprotRecord(block) -> sciweon record` that the orchestrator
 * (uniprot-sprot-harvest.js) wires to the gunzip stream.
 *
 * FULL-CORPUS, FULL-RECORD (founder ruling "preserve all source data"): NO organism
 * filter, NO field whitelist -- every record + every DR xref is captured. Organism /
 * xref-source scope is a downstream (PR-UNIPROT-2 merge-boundary) concern, not here.
 *
 * Determinism (GEMINI.md Sec 7, byte-identical): db_xrefs sorted by (source,id),
 * ec_numbers + secondary_accessions sorted lexically, function_descriptions kept in
 * stable source order. The harvest writes records in INPUT STREAM ORDER (.dat is a
 * stable file; a retry re-downloads from byte 0 -> identical input/output). No
 * Date.now / Math.random in any output field.
 *
 * No silent drop ([[cross_cycle_silent_data_loss]]): a record with no parseable OX is
 * COUNTED (no_ox), organism.taxon_id null, kept not dropped. A record with no AC
 * (no primary accession) is the ONLY hard-fail; the orchestrator treats the throw as
 * a fatal parse error.
 */

// SwissProt .dat record delimiter line ("//" on its own line ends every entry).
export const RECORD_DELIMITER = '//';

// Per-record DR cross-ref cap: a sane upper bound so a pathological record cannot
// blow memory. SwissProt records carry tens-to-low-hundreds of DR lines; 4096 is far
// above any real record. If a record EXCEEDS it, the overflow is COUNTED + logged
// LOUDLY by the orchestrator (capInfo on the parsed record), NEVER silently dropped.
export const DR_XREF_CAP = 4096;

export const UNIPROT_LICENSE = 'cc-by-4.0';
export const SCHEMA_VERSION = 'pr-uniprot-1';

/**
 * splitRecordBlocks -- split a chunk of .dat text into COMPLETE record blocks on the
 * "//" delimiter line (verbatim from lib/uniprot-sprot-probe.js). Returns
 * { blocks, remainder }; the caller carries `remainder` to the next chunk (a record
 * may span chunk boundaries). A block is the text BETWEEN delimiters; trailing text
 * with no closing "//" stays in remainder (a half record is not a record).
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
    const remainder = lastDelimLineIdx < 0
        ? String(text ?? '')
        : lines.slice(lastDelimLineIdx + 1).join('\n');
    return { blocks, remainder };
}

/** True iff `block` contains at least one non-blank, non-delimiter line. */
export function isNonEmptyBlock(block) {
    return /\S/.test(String(block ?? '')) && String(block).trim() !== RECORD_DELIMITER;
}

/** Lexical sort comparator (stable, locale-independent for byte-identical output). */
function lexCmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * parseUniprotRecord -- HARDENED pure parse of ONE .dat record block (delimiter
 * excluded) to the Sciweon UniProt bulk record, built from the PR-0-verified line-code
 * map. Throws ONLY when the record has no AC primary accession (a structurally invalid
 * entry -> the orchestrator fatal-fails; no silent drop). Returns the record + a
 * non-enumerable `_meta` (no_ox flag, dr_capped count) read by the orchestrator for
 * telemetry; recordToJsonl drops `_meta` on serialize.
 *
 * @param {string} block   one record block (// delimiter excluded)
 * @returns {object}       sciweon record + non-enumerable `_meta`
 */
export function parseUniprotRecord(block) {
    const lines = String(block ?? '').split('\n');

    let primary = null;
    const secondary = [];
    let recommendedName = null;
    const ecSet = new Set();
    let geneSymbol = null;
    let scientificNameParts = [];
    let taxonId = null;
    let idLen = null;
    let sqLen = null;
    let sqMw = null;
    const functionDescriptions = [];
    const drXrefs = [];
    let drCapped = 0;
    let sawOx = false;
    let inFunctionCc = false;

    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const code = line.slice(0, 2);
        const body = line.slice(5); // EMBL: cols 1-2 code, then 3 spaces, then body

        if (code === 'ID') {
            if (idLen === null) {
                const m = line.match(/\b(\d+)\s+AA\.?/);
                if (m) idLen = Number(m[1]);
            }
        } else if (code === 'AC') {
            // Multi-AC: first token of the first AC line = primary; the rest = secondary.
            const toks = body.split(';').map(t => t.trim()).filter(Boolean);
            for (const t of toks) {
                if (primary === null) primary = t;
                else secondary.push(t);
            }
        } else if (code === 'DE') {
            if (recommendedName === null) {
                const m = line.match(/RecName:\s*Full=([^;{]+)/); // first RecName Full wins
                if (m) recommendedName = m[1].trim();
            }
            const ecM = line.match(/EC=([0-9]+\.[0-9]+\.[0-9]+\.[0-9n-]+)/); // capture ALL EC
            if (ecM) ecSet.add(ecM[1].trim());
        } else if (code === 'GN') {
            if (geneSymbol === null) {
                const m = line.match(/Name=([^;{]+)/); // may be absent -> stays null
                if (m) geneSymbol = m[1].trim();
            }
        } else if (code === 'OS') {
            if (body.trim()) scientificNameParts.push(body.trim()); // may span OS lines
        } else if (code === 'OX') {
            sawOx = true;
            if (taxonId === null) {
                const m = line.match(/NCBI_TaxID=(\d+)/);
                if (m) taxonId = Number(m[1]);
            }
        } else if (code === 'SQ') {
            const ml = line.match(/SEQUENCE\s+(\d+)\s+AA/);
            if (ml && sqLen === null) sqLen = Number(ml[1]);
            const mw = line.match(/;\s*(\d+)\s+MW/);
            if (mw && sqMw === null) sqMw = Number(mw[1]);
        } else if (code === 'CC') {
            // "-!- FUNCTION:" begins a topic continuing on following CC lines until the
            // next "-!-" topic / blank; accumulate the full text.
            const fnStart = body.match(/^-!-\s*FUNCTION:\s*(.*)$/);
            if (fnStart) {
                inFunctionCc = true;
                functionDescriptions.push(fnStart[1].trim());
            } else if (inFunctionCc) {
                if (/^-!-/.test(body.trim()) || body.trim() === '') {
                    inFunctionCc = false; // a new topic / blank ends the FUNCTION block
                } else {
                    // continuation line -> append to the current FUNCTION description
                    const cont = body.trim();
                    if (cont) {
                        const last = functionDescriptions.length - 1;
                        functionDescriptions[last] = (functionDescriptions[last] + ' ' + cont).trim();
                    }
                }
            }
        } else if (code === 'DR') {
            // "DR   <SOURCE>; <id>; ...;" -- capture ALL DR sources (no whitelist).
            const toks = body.split(';').map(t => t.trim());
            const source = toks[0];
            const id = toks[1] ?? '';
            if (source) {
                if (drXrefs.length < DR_XREF_CAP) drXrefs.push({ source, id });
                else drCapped += 1;
            }
        }
    }

    if (primary === null) {
        throw new Error('parseUniprotRecord: record has no AC primary accession (structurally malformed)');
    }

    // sequence_length: prefer the SQ "SEQUENCE N AA" value (authoritative), cross-check
    // with the ID-line length; keep whichever is present (SQ wins if both).
    const sequenceLength = sqLen ?? idLen ?? null;

    // Deterministic inner ordering for byte-identical output.
    secondary.sort(lexCmp);
    const ecNumbers = [...ecSet].sort(lexCmp);
    drXrefs.sort((a, b) => lexCmp(a.source, b.source) || lexCmp(a.id, b.id));

    const record = {
        accession: primary,
        secondary_accessions: secondary,
        recommended_name: recommendedName,
        ec_numbers: ecNumbers,
        gene_symbol: geneSymbol,
        organism: {
            scientific_name: scientificNameParts.length
                ? scientificNameParts.join(' ').replace(/\.$/, '').trim()
                : null,
            taxon_id: taxonId,
        },
        sequence_length: sequenceLength,
        sequence_mol_weight: sqMw,
        function_descriptions: functionDescriptions,
        db_xrefs: drXrefs,
        license: UNIPROT_LICENSE,
    };

    Object.defineProperty(record, '_meta', {
        value: { no_ox: !sawOx, dr_capped: drCapped },
        enumerable: false,
    });
    return record;
}

/** Fresh per-taxon tally accumulator (telemetry only; never a filter). */
export function newTaxonTally() {
    return new Map();
}

/** tallyTaxon -- count ONE record's taxon (telemetry, NOT a filter; null -> 'no_ox'). */
export function tallyTaxon(tally, record) {
    const key = record?.organism?.taxon_id ?? 'no_ox';
    tally.set(key, (tally.get(key) || 0) + 1);
    return tally;
}

/** Serialize a parsed record to its public JSONL shape (drops the non-enum _meta). */
export function recordToJsonl(record) {
    return JSON.stringify({
        accession: record.accession,
        secondary_accessions: record.secondary_accessions,
        recommended_name: record.recommended_name,
        ec_numbers: record.ec_numbers,
        gene_symbol: record.gene_symbol,
        organism: record.organism,
        sequence_length: record.sequence_length,
        sequence_mol_weight: record.sequence_mol_weight,
        function_descriptions: record.function_descriptions,
        db_xrefs: record.db_xrefs,
        license: record.license,
    });
}
