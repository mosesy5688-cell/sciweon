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
