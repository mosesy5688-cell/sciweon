/**
 * UMLS Public Projection -- PR-UMLS-2a COMPLIANCE CORE (founder FINAL RULING,
 * NON-NEGOTIABLE). The SINGLE SSoT for projecting ANY UMLS-derived concept record
 * down to its publicly-redistributable shape, so the per-vocab redistribution rule
 * can never drift apart across the MeSH / SNOMED / LOINC public builders.
 *
 * THE BREACH THIS REMEDIATES: the UMLS Metathesaurus License forbids redistributing
 * the CUI (an NLM-proprietary structural identifier) to non-licensees. The MeSH public
 * artifact (mesh-concepts.jsonl, 355,249 records) shipped into the public snapshot with
 * `cui` present -> an active redistribution breach. The fix is a UNIVERSAL cui-withhold
 * applied to ALL UMLS public concept artifacts via this one function.
 *
 * projectUmlsPublic(vocab, record) returns a NEW object built field-by-field from a
 * STRICT ALLOWLIST (never a spread / Object.assign / pick-by-omit -- a future field
 * added to the internal concept record CANNOT leak into the public artifact unless this
 * allowlist is explicitly widened, which the compliance test catches in CI):
 *
 *   CUI is ALWAYS annihilated (universal -- every vocabulary, no exception).
 *
 *   vocab === 'SNOMED'         -> { sid_s, sid_c }
 *       (Appendix-2 ruling: SNOMED CT is Affiliate-restricted; the public artifact is
 *        Sciweon-original SID hashes ONLY -- code + str ALSO dropped, CUI annihilated.)
 *
 *   vocab === 'MESH' | 'LOINC' -> { sid_s, sid_c, code, str }
 *       (Cat-0 ruling: MeSH (MSH D-codes) + LOINC codes + their preferred strings are
 *        Cat-0 / NLM-public-domain text -- KEPT; only the proprietary CUI is dropped.)
 *
 *   unknown vocab              -> throw [COMPLIANCE_FATAL]
 *       (fail-closed: an unrecognized vocabulary is NEVER projected with a guessed rule;
 *        adding a new UMLS vocabulary is a deliberate, audited edit to this switch.)
 *
 * The public `str` key maps from the internal concept's `preferred_str` field (the
 * harvest lib's preferred-atom string; see umls-concept-streams.js toConceptRecord).
 * `synonyms` are intentionally OUT of the public concept payload (the founder spec lists
 * exactly {sid_s,sid_c,code,str}); they are Cat-0 text and could be added later, but the
 * default allowlist is the minimal spec'd set so no extra field rides along silently.
 */

// The frozen per-vocab allowlists. Widening any of these is a constitutional change --
// the umls-public-projection compliance test pins the exact key set so any edit is caught.
export const SNOMED_PUBLIC_KEYS = Object.freeze(['sid_s', 'sid_c']);
export const CAT0_PUBLIC_KEYS = Object.freeze(['sid_s', 'sid_c', 'code', 'str']);

/**
 * Project ONE internal (full, cui-bearing) UMLS concept record to its public shape.
 *
 * Pure: constructs a new object; never mutates the input. Reads ONLY the allowlisted
 * fields for the given vocab. CUI is never read into the output (universal annihilation).
 *
 * @param {'SNOMED'|'MESH'|'LOINC'} vocab  the source vocabulary processor
 * @param {object} record                  a stamped internal UMLS concept record
 * @returns {object}  the public projection (SNOMED: {sid_s,sid_c};
 *                     MESH/LOINC: {sid_s,sid_c,code,str}). CUI ALWAYS absent.
 */
export function projectUmlsPublic(vocab, record) {
    const r = record && typeof record === 'object' ? record : {};
    if (vocab === 'SNOMED') {
        // Appendix-2: Sciweon-original SID hashes ONLY (code + str + cui all dropped).
        return {
            sid_s: r.sid_s,
            sid_c: r.sid_c,
        };
    }
    if (vocab === 'MESH' || vocab === 'LOINC') {
        // Cat-0: keep the public code + preferred string; the proprietary CUI is dropped.
        // `str` maps from the internal `preferred_str` field (NEVER from a `cui`-adjacent
        // field). Explicit field-by-field construction -- no spread, so cui cannot leak.
        return {
            sid_s: r.sid_s,
            sid_c: r.sid_c,
            code: r.code,
            str: r.preferred_str,
        };
    }
    // Fail-closed: an unknown vocabulary is a programming/compliance error, never a
    // best-effort projection. Halt loud so the missing rule is added deliberately.
    throw new Error('[COMPLIANCE_FATAL] Unknown vocabulary processor: ' + vocab);
}
