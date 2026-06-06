/**
 * V0.5.6 — Trial intervention name selector.
 *
 * ClinicalTrials.gov `query.intr` expects consumer-facing drug names
 * (aspirin, imatinib, tamoxifen) — NOT IUPAC, NOT CAS, NOT chemical
 * identifiers. Pre-V0.5.6 priority (IUPAC -> synonyms[0] -> CID) yielded
 * ~0 trials per compound because IUPAC is unsearchable in CT.gov
 * intervention space.
 *
 * ===== THE HTTP 400 FLOOD FIX (no_searchable_name terminal) =====
 * The legacy `iupac_fallback` (a raw IUPAC name when there is no rxnorm_name +
 * no clean synonym) was NOT merely zero-hit -- CT.gov `query.intr` parses Essie
 * search syntax where `[ ] ( ) , ;` are OPERATORS, so a bracketed IUPAC string
 * (e.g. "(1S)-4,17-dimethyl-17-azatetracyclo[7.5.3.01,10.02,7]heptadeca-...") is
 * a MALFORMED query that DETERMINISTICALLY returns HTTP 400 -- a flood of
 * `[CT] intervention "<iupac>": HTTP 400` every wrap, mis-counted as a transient
 * fetch failure (see trial-linker.js). A bracketed IUPAC is NEVER searchable, so
 * "only if < 200 chars" never made it safe. We therefore DROP the iupac_fallback
 * and return a distinct `no_searchable_name` sentinel ({name:null}) so the linker
 * RECORDS the negative (this CID has no CT.gov-searchable name -- loud telemetry,
 * re-queryable when a name later appears) WITHOUT sending a doomed 400-ing query
 * ([[evidence_not_verdict]]: record the queryable negative, never silently skip,
 * never infinitely retry).
 *
 * Priority chain:
 *   1. external_ids.rxnorm_name   (NLM RxNav authoritative drug name)
 *   2. best synonym               (shortest non-systematic-code candidate)
 *   3. `CID:<n>`                  (a valid HTTP 200 query; expected zero hits,
 *                                  logged for audit -- NOT the 400-ing IUPAC)
 *   --> if NONE of the above produce a usable name: {name:null,
 *       source:'no_searchable_name'} (terminal -- skip CT.gov, count distinctly).
 *
 * Note: a compound with a real pubchem_cid still resolves to `CID:<n>` (a safe,
 * if zero-hit, HTTP 200 query). `no_searchable_name` is reached only when there
 * is no rxnorm_name, no clean synonym, AND no pubchem_cid to form `CID:<n>`.
 *
 * Pure functions — no I/O. Tested in tests/factory/trial-search-name.test.ts.
 */

function isSystematicCode(s) {
    if (typeof s !== 'string' || !s) return true;
    if (/^\d+-\d+-\d+$/.test(s)) return true;            // CAS: 50-78-2
    if (/^[A-Z]+:\d+$/.test(s)) return true;             // CHEBI:1234, KEGG:D00109
    if (/^[A-Z]{2,}[- ]?\d{3,}$/.test(s)) return true;   // catalog codes: NSC-123456, AB 12345
    if (s.length > 80) return true;                       // long systematic / IUPAC-ish
    const letters = (s.match(/[a-zA-Z]/g) || []).length;
    if (letters < s.length * 0.5) return true;            // mostly non-alpha
    return false;
}

export function pickBestSynonym(synonyms) {
    if (!Array.isArray(synonyms) || synonyms.length === 0) return null;
    const candidates = synonyms.filter(s => !isSystematicCode(s));
    if (candidates.length === 0) return null;
    return candidates.reduce((best, cur) => cur.length < best.length ? cur : best);
}

export function pickTrialSearchName(compound) {
    const rx = compound.external_ids?.rxnorm_name;
    if (typeof rx === 'string' && rx.length > 0 && rx.length < 200) {
        return { name: rx, source: 'rxnorm_name' };
    }
    const synonym = pickBestSynonym(compound.synonyms);
    if (synonym) {
        return { name: synonym, source: 'synonym' };
    }
    // No rxnorm_name and no clean synonym -> the only remaining candidates would
    // be a raw IUPAC string (CT.gov Essie `query.intr` cannot parse the bracket /
    // comma operators -> HTTP 400) or a `CID:<n>` placeholder (a valid HTTP 200
    // query but GUARANTEED zero hits -- CT.gov interventions are never indexed by
    // PubChem CID, so it is a wasted request, not a searchable name). NEITHER is a
    // CT.gov-searchable consumer-facing drug name, so return the terminal sentinel
    // (name:null): the linker records the negative (loud no_searchable_name count,
    // re-queryable when a real name later appears) and skips CT.gov entirely --
    // never sending a doomed query, never counting it as a transient fetch failure
    // ([[evidence_not_verdict]]: a recorded queryable negative, not a silent skip
    // and not an infinite retry).
    return { name: null, source: 'no_searchable_name' };
}
