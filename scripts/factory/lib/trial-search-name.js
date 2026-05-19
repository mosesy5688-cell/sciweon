/**
 * V0.5.6 — Trial intervention name selector.
 *
 * ClinicalTrials.gov `query.intr` expects consumer-facing drug names
 * (aspirin, imatinib, tamoxifen) — NOT IUPAC, NOT CAS, NOT chemical
 * identifiers. Pre-V0.5.6 priority (IUPAC -> synonyms[0] -> CID) yielded
 * ~0 trials per compound because IUPAC is unsearchable in CT.gov
 * intervention space.
 *
 * Priority chain (V0.5.6+):
 *   1. external_ids.rxnorm_name   (NLM RxNav authoritative drug name)
 *   2. best synonym               (shortest non-systematic-code candidate)
 *   3. iupac_name                 (only if < 200 chars; legacy last-resort)
 *   4. `CID:<n>`                  (expected zero hits — logged for audit)
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
    if (typeof compound.iupac_name === 'string' && compound.iupac_name.length > 0 && compound.iupac_name.length < 200) {
        return { name: compound.iupac_name, source: 'iupac_fallback' };
    }
    return { name: `CID:${compound.pubchem_cid}`, source: 'cid_fallback' };
}
