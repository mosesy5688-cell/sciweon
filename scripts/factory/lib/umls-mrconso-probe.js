/**
 * PR-UMLS-0: pure helpers for the UMLS MRCONSO diagnostic probe. No network / no I/O
 * -- unit-testable. The probe script (diagnostic-umls-mrconso-probe.js) wraps these
 * with the UMLS apiKey-proxy download + StreamZip MRCONSO stream.
 *
 * DOC_SAB_INDEX is the UMLS-DOCUMENTED MRCONSO SAB column position -- treated as
 * TENTATIVE only (per [[external_dataset_diagnostic_first]] the probe dumps RAW
 * positional rows so the real column->value map is VERIFIED against data before any
 * filter logic trusts this index; the RxNorm RXNSAT precedent had a doc-wrong order).
 */

// MRCONSO documented order: CUI,LAT,TS,LUI,STT,SUI,ISPREF,AUI,SAUI,SCUI,SDUI,SAB(11),
// TTY(12),CODE(13),STR(14),SRL,SUPPRESS,CVF. DOC-ASSUMED -- verify against the raw dump.
export const DOC_SAB_INDEX = 11;
export const TARGET_SABS = ['MSH', 'SNOMEDCT_US', 'LNC'];

// ZIP local-file-header magic ("PK\x03\x04"). A real Metathesaurus full release is a
// ZIP; the apiKey proxy returns 200 + a ~196-byte error/redirect body for a NON-existent
// inner URL (PR-UMLS-0 Bug 1). Magic is the PRIMARY truth signal: a 196-byte HTML/text
// body never starts with PK\x03\x04.
export const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// 100 MB floor. The real Metathesaurus full zip is multi-GB; 100 MB is a deliberate
// secondary corroborator (NOT 1 MB) that any plausible real release clears and any
// proxy false-200 stub (hundreds of bytes) fails. PM-locked value.
export const MIN_RELEASE_BYTES = 100_000_000;

/**
 * Pure archive-head classifier (no I/O, never throws). Given the first bytes of a
 * candidate download + its Content-Length, decide whether it looks like a real release.
 *
 *   is_zip     headBuf is a Buffer of length>=4 whose first 4 bytes equal ZIP_MAGIC.
 *   size_ok    Content-Length present+numeric -> >= MIN_RELEASE_BYTES; ABSENT/NaN -> true
 *              (magic-alone fallback: some proxies stream without a length header).
 *   looks_real is_zip && size_ok (magic PRIMARY, size SECONDARY corroborator).
 *   magic_hex  hex of the first up-to-4 bytes, for logging.
 *
 * @param {Buffer} headBuf        first bytes off the response stream
 * @param {string|number} contentLength  the Content-Length header value (may be absent)
 */
export function classifyArchiveHead(headBuf, contentLength) {
    const isBuf = Buffer.isBuffer(headBuf);
    const is_zip = isBuf && headBuf.length >= 4 && headBuf.subarray(0, 4).equals(ZIP_MAGIC);
    const magic_hex = isBuf ? headBuf.subarray(0, 4).toString('hex') : '';
    let size_ok = true;
    if (contentLength !== undefined && contentLength !== null && contentLength !== '') {
        const n = Number(contentLength);
        size_ok = Number.isNaN(n) ? true : n >= MIN_RELEASE_BYTES;
    }
    return { is_zip, magic_hex, size_ok, looks_real: is_zip && size_ok };
}

/**
 * Candidate UMLS Metathesaurus full-release inner URLs, NEWEST-FIRST. The probe
 * status-probes each (Range 0-1) and picks the first 200 -- NOT a hardcoded "the" URL.
 * Two filename variants per release (full vs base) so a naming guess never blocks
 * discovery; an operator --full-url override bypasses this entirely.
 */
export function candidateMetathesaurusUrls(now = new Date()) {
    const base = 'https://download.nlm.nih.gov/umls/kss';
    const y = now.getUTCFullYear();
    const urls = [];
    for (const yr of [y, y - 1, y - 2]) {
        for (const ab of ['AB', 'AA']) {        // AB (fall) before AA (spring) = reverse-chron
            const rel = `${yr}${ab}`;
            urls.push(`${base}/${rel}/umls-${rel}-metathesaurus-full.zip`);
            urls.push(`${base}/${rel}/umls-${rel}-metathesaurus.zip`);
        }
    }
    return urls;
}

/** Fresh per-target-SAB tally (+ other) for a streaming pass. */
export function newSabTally() {
    return { MSH: 0, SNOMEDCT_US: 0, LNC: 0, other: 0 };
}

/**
 * Tally ONE positional MRCONSO row's SAB (at the tentative DOC_SAB_INDEX) into the
 * running tally. Pure (mutates + returns the passed tally). Non-target SAB -> other.
 */
export function addSabTally(tally, fields) {
    const sab = Array.isArray(fields) ? fields[DOC_SAB_INDEX] : undefined;
    if (sab === 'MSH' || sab === 'SNOMEDCT_US' || sab === 'LNC') tally[sab] += 1;
    else tally.other += 1;
    return tally;
}
