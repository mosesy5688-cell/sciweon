/**
 * NDC (National Drug Code) HIPAA 11-digit normalizer (PR-RXN-1 LOCK 2).
 *
 * NDC values in RxNorm RXNSAT.RRF (ATN='NDC') arrive in three HIPAA-permissible
 * variant forms, each zero-padded to a different segment to reach exactly
 * 11 digits:
 *   4-4-2 input "0042-0220-01" -> "00042022001"  (pad labeler 4 -> 5)
 *   5-3-2 input "50242-040-62" -> "50242004062"  (pad product 3 -> 4)
 *   5-4-1 input "12345-6789-0" -> "12345067890"  (pad package 1 -> 2)
 * Already-11-digit numeric input passes through unchanged.
 *
 * Architect-locked LOCK 2: strict post-normalization /^[0-9]{11}$/ regex.
 * On regex miss (10-digit abbreviated variants, non-numeric chars, length
 * drift) return null; caller increments dropped_count.malformed_ndc.
 * Never let unverified NDC strings reach the R2 artifact -- downstream
 * hash-equality lookups depend on byte-exact normalization.
 */

const NDC_11_DIGIT = /^[0-9]{11}$/;

export function normalizeNdcTo11Digit(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    // Pre-stripped numeric: pass through only if already 11 digits.
    if (/^[0-9]+$/.test(trimmed)) {
        return trimmed.length === 11 ? trimmed : null;
    }

    // Hyphen-separated: must be exactly 3 segments.
    const parts = trimmed.split('-');
    if (parts.length !== 3) return null;
    for (const p of parts) {
        if (!/^[0-9]+$/.test(p)) return null;
    }
    const [labeler, product, pkg] = parts;

    let normalized;
    if (labeler.length === 4 && product.length === 4 && pkg.length === 2) {
        normalized = '0' + labeler + product + pkg;
    } else if (labeler.length === 5 && product.length === 3 && pkg.length === 2) {
        normalized = labeler + '0' + product + pkg;
    } else if (labeler.length === 5 && product.length === 4 && pkg.length === 1) {
        normalized = labeler + product + '0' + pkg;
    } else if (labeler.length === 5 && product.length === 4 && pkg.length === 2) {
        normalized = labeler + product + pkg;
    } else {
        return null;
    }

    return NDC_11_DIGIT.test(normalized) ? normalized : null;
}
