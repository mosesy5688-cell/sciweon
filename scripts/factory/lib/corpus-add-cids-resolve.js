/**
 * PR-MD-2b: pure UNII -> CID resolution + coverage logic (the addressability gate
 * for the corpus surgical add-list). The I/O (R2 read of the 2a add-list,
 * loadLookupFromR2, UniChem fetch, R2 emit) lives in resolve-corpus-add-cids.js;
 * this module is the testable core (no network, no R2).
 *
 * Flow per target UNII u:
 *   - invert the InChIKey-keyed FDA SRS map to UNII-keyed (lossless: every artifact
 *     row carries an InChIKey because the harvest drops no-InChIKey rows).
 *   - u not in the inverted index -> reason `no_srs_inchikey` (the AUTHORITATIVE SRS
 *     record carries no small-molecule InChIKey; these FDA UNIIs ARE in SRS, so this
 *     is a clean small-molecule/macromolecule dichotomy -- NOT an arbitrary slice).
 *   - u has an InChIKey but UniChem returns no pubchem_cid -> reason `no_cid`.
 *   - else resolvable {unii, inchikey, cid, name}. The `unii` is the TARGET u so 2c
 *     can inject external_ids.unii = u directly (Collar A; never trust UniChem's
 *     keep-first reverse UNII).
 *
 * slice_not_world: resolvable_n is an UPPER BOUND on 2c's added_n (2c further attrits
 * at the schema-tier scope gate -- macromolecule etc.). The artifact note says so.
 */

/**
 * Invert an InChIKey-keyed SRS map (value {unii, preferred_name, ...}) to a
 * UNII-keyed index {inchi_key, name}. Pure. Multi-InChIKey -> same-UNII is
 * last-write-wins (harmless: any valid InChIKey resolves the UNII).
 */
export function invertSrsToUniiIndex(inchiKeyedMap) {
    const idx = new Map();
    if (!(inchiKeyedMap instanceof Map)) return idx;
    for (const [inchiKey, v] of inchiKeyedMap) {
        const u = v?.unii;
        if (typeof u === 'string' && u) idx.set(u, { inchi_key: inchiKey, name: v?.preferred_name ?? null });
    }
    return idx;
}

/**
 * Classify one target UNII. `inchiKeyOrNull` = uniiIndex.get(u)?.inchi_key;
 * `pubchemCidOrNull` = the UniChem-resolved CID for that InChIKey (or null).
 * Returns either a resolvable entry or {unii, reason}.
 */
export function classifyUniiResolution(unii, inchiKeyOrNull, pubchemCidOrNull, name = null, cidSource = null) {
    if (!inchiKeyOrNull) return { unii, reason: 'no_srs_inchikey' };
    if (!pubchemCidOrNull) return { unii, reason: 'no_cid', inchikey: inchiKeyOrNull };
    // PR-MD-2b.1: cid_source records provenance (unichem | pubchem_inchikey) for 2c audit.
    return { unii, inchikey: inchiKeyOrNull, cid: String(pubchemCidOrNull), name, cid_source: cidSource };
}

const isResolvable = (e) => e && e.cid != null && !e.reason;

/** Coverage tally over classified entries. Pure. */
export function summarizeCoverage(classified) {
    const arr = Array.isArray(classified) ? classified : [];
    const by_reason = {};
    let resolvable_n = 0;
    for (const e of arr) {
        if (isResolvable(e)) resolvable_n++;
        else by_reason[e.reason] = (by_reason[e.reason] || 0) + 1;
    }
    return { target: arr.length, resolvable_n, unresolvable_n: arr.length - resolvable_n, by_reason };
}

/** Build the emitted artifact. Pure. */
export function buildAddCidsArtifact(classified) {
    const arr = Array.isArray(classified) ? classified : [];
    return {
        schema_version: 1,
        note: 'resolvable_n is an UPPER BOUND on PR-MD-2c added_n (2c attrits further at the schema-tier scope gate -- macromolecule etc.). Do not assume all resolvable link. no_srs_inchikey = authoritative FDA SRS has no small-molecule InChIKey (likely biologic/macromolecule), NOT a hard per-row biologic stamp.',
        coverage: summarizeCoverage(arr),
        resolvable: arr.filter(isResolvable),
        unresolvable: arr.filter(e => e && e.reason).map(e => ({ unii: e.unii, reason: e.reason })),
    };
}
