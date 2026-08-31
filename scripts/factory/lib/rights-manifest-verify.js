/**
 * F0-RIGHTS-REGISTRY -- independent capture-manifest verification.
 *
 * Split from `rights-registry.js` to stay under the 250-line code cap.
 *
 * WHY THIS IS SEPARATE, AND WHY IT MATTERS
 *
 * Adjudication answers "may this source and field be published at all?".
 * Verification answers "is this unit actually the thing it claims to be?".
 * They are different questions and a caller must not be able to satisfy the
 * second by asserting it. A `capture_ref` that is merely a non-empty string is
 * a self-declaration, not evidence -- the same failure shape as an author
 * signing off their own work.
 *
 * Pure functions only -- no I/O, no R2, no network.
 */

function normalise(s) {
    return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Verify a unit's claimed capture against an INDEPENDENT manifest.
 *
 * Correction 2. A `capture_ref` that is merely a non-empty string proves
 * nothing. The reference must resolve; the resolved capture's source must
 * match the declared source; and the pointer must be recorded against that
 * capture. Without a manifest there is no verification and the caller is told
 * so rather than being waved through.
 */
export function verifyAgainstManifest(unit, manifest) {
    const declaredSource = normalise(unit?.source);
    const ref = typeof unit?.capture_ref === 'string' ? unit.capture_ref.trim() : '';
    const ptr = typeof unit?.source_pointer === 'string' ? unit.source_pointer.trim() : '';

    if (!Array.isArray(manifest)) return { verified: false, reason: 'no_manifest_supplied' };
    if (!ref) return { verified: false, reason: 'missing_capture_ref' };
    if (!ptr) return { verified: false, reason: 'missing_source_pointer' };

    const entry = manifest.find(m => m && m.capture_ref === ref);
    if (!entry) return { verified: false, reason: 'capture_ref_not_in_manifest' };

    const captureSource = normalise(entry.source);
    if (!captureSource) return { verified: false, reason: 'manifest_entry_has_no_source' };
    if (captureSource !== declaredSource) {
        return {
            verified: false,
            reason: 'declared_source_does_not_match_capture',
            declared_source: declaredSource,
            capture_source: captureSource,
        };
    }
    const pointers = Array.isArray(entry.source_pointers) ? entry.source_pointers : null;
    if (!pointers) return { verified: false, reason: 'manifest_entry_records_no_pointers' };
    if (!pointers.includes(ptr)) return { verified: false, reason: 'pointer_not_recorded_for_capture' };

    return { verified: true, reason: 'manifest_verified', capture_ref: ref, capture_source: captureSource };
}
