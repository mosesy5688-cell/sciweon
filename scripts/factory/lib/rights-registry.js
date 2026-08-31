/**
 * F0-RIGHTS-ENFORCEMENT -- the Gate-5B frozen rights registry.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * This implements EXACTLY the 25 rights-bearing fields and three data planes
 * that Gate-5B adjudicated and froze. Nothing else. It is not a general rights
 * engine, it does not infer, and it does not generalise from a source that
 * "looks open". A field that was not adjudicated is UNRESOLVED, and unresolved
 * fails closed on any public surface.
 *
 * WHY FAIL-CLOSED IS THE WHOLE POINT
 *
 * The pre-existing containment (`src/worker/lib/source-rights-filter.ts`) is a
 * DENYLIST applied at serialization: it removes shapes it recognises. A new
 * source, a renamed field, or a reshaped payload passes straight through. That
 * is survivable for a hosted surface that can be patched; it is not survivable
 * for an artifact shipped to a customer machine, which cannot be.
 *
 * This registry inverts that: nothing is publishable unless it was adjudicated.
 *
 * RIGHTS TRAVEL WITH THE DATA
 *
 * `attachRights()` writes the rights envelope INTO the content unit at build
 * time. Rights are then a property of the record, not a behaviour of one
 * serializer, and they survive being written to a snapshot, copied, or shipped.
 *
 * PROVENANCE OF THE 25 FIELDS
 *
 * Extracted read-only from the immutable Round-11 evidence
 * (`SCIWEON_GATE5B_ROUND11_EVIDENCE.zip`, sha256 c513da40...), from
 * `SCIWEON_FD9_GATE5B_TRUTH_REPAIR_v1.2/fd9_demo_v1_3/output/{clean-commercial,
 * licensed-sharealike,bibliographic}-plane.json`. Counts reconcile exactly with
 * the Decision Log: 5 PubChem + 14 ChEMBL + 6 PubMed = 25.
 *
 * DO NOT ADD A FIELD HERE WITHOUT A FOUNDER RULING. This list is frozen.
 */

export const PLANE_CLEAN_COMMERCIAL = 'CLEAN_COMMERCIAL';
export const PLANE_LICENSED_SHAREALIKE = 'LICENSED_SHAREALIKE';
export const PLANE_BIBLIOGRAPHIC = 'BIBLIOGRAPHIC';

export const STATE_UNRESOLVED = 'RIGHTS_UNRESOLVED';
export const STATE_WITHHELD = 'WITHHELD_NO_APPROVED_LICENCE_EVIDENCE';

/**
 * Plane metadata. Note the CLEAN_COMMERCIAL state name: Gate-5B ruled that
 * PubChem cannot derive an unconditional CLEAN_COMMERCIAL_ATTRIBUTION, and any
 * such derivation is refused with POSITIVE_GRANT_NOT_SUPPORTED. The qualified
 * state is therefore the ONLY state its members carry, and the plane name
 * being broader than its members is a known, founder-noted wart -- which is
 * exactly why the per-field state is forced into view on every unit.
 */
export const PLANES = Object.freeze({
    [PLANE_CLEAN_COMMERCIAL]: Object.freeze({
        rights_state: 'CLEAN_COMMERCIAL_FIELD_QUALIFIED',
        source: 'pubchem',
        licence: null,
        licence_url: null,
        attribution: 'PubChem, NIH/NCBI',
        obligations: Object.freeze(['field_qualified_only', 'no_unconditional_commercial_grant']),
    }),
    [PLANE_LICENSED_SHAREALIKE]: Object.freeze({
        rights_state: 'LICENSED_SHAREALIKE',
        source: 'chembl',
        licence: 'CC BY-SA 3.0 Unported',
        licence_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
        attribution: 'ChEMBL, EMBL-EBI',
        obligations: Object.freeze(['attribution', 'share_alike', 'physically_separate_plane']),
    }),
    [PLANE_BIBLIOGRAPHIC]: Object.freeze({
        rights_state: 'NO_LICENCE_GRANTED_ATTRIBUTION_REQUIRED',
        source: 'pubmed',
        licence: null,
        licence_url: null,
        attribution: 'Courtesy of the U.S. National Library of Medicine',
        obligations: Object.freeze(['attribution', 'currency_disclosure_on_republication']),
    }),
});

/**
 * Genuinely immutable membership set.
 *
 * `Object.freeze(new Set([...]))` does NOT work: freeze only seals own
 * properties, while a Set's contents live in internal slots, so `.add()`
 * still succeeds silently. A "frozen" allowlist that can be extended at
 * runtime is worse than no allowlist, because it reads as a guarantee.
 * This returns a frozen facade with membership and iteration and NO mutators.
 */
function frozenSet(values) {
    const inner = new Set(values);
    return Object.freeze({
        has: v => inner.has(v),
        get size() { return inner.size; },
        values: () => inner.values(),
        [Symbol.iterator]: () => inner.values(),
        toArray: () => [...inner],
    });
}

/** The frozen 25. source -> immutable field set. Nothing else is publishable. */
export const ADJUDICATED_FIELDS = Object.freeze({
    pubchem: frozenSet([
        'pubchem_cid', 'inchi_key', 'molecular_formula', 'connectivity_smiles', 'iupac_name',
    ]),
    chembl: frozenSet([
        'chembl_db_version', 'chembl_release_date', 'chembl_target_id', 'chembl_id',
        'assay_chembl_id', 'assay_description', 'assay_organism', 'standard_type',
        'standard_relation', 'standard_value', 'standard_units', 'pchembl_value',
        'source_record_activity_id', 'document_chembl_id',
    ]),
    pubmed: frozenSet([
        'pmid', 'doi', 'journal', 'pubdate', 'volume', 'pages',
    ]),
});

const SOURCE_TO_PLANE = Object.freeze({
    pubchem: PLANE_CLEAN_COMMERCIAL,
    chembl: PLANE_LICENSED_SHAREALIKE,
    pubmed: PLANE_BIBLIOGRAPHIC,
});

/**
 * Sources ruled WITHHELD. UniProt (5 items) and UniChem (1 item) are the
 * Gate-5B withheld record. MedDRA and KEGG are the RC-3A restricted families.
 * A withheld source is never publishable regardless of field.
 */
export const WITHHELD_SOURCES = frozenSet(['uniprot', 'unichem', 'meddra', 'kegg']);

export const TOTAL_ADJUDICATED_FIELDS = Object.values(ADJUDICATED_FIELDS)
    .reduce((n, s) => n + s.size, 0);

function normalise(s) {
    return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Resolve the rights position of one (source, field) pair.
 *
 * Every path that is not an exact adjudicated match returns an unpublishable
 * result. There is no "probably fine" branch, and unknown input shapes
 * (non-strings, null, objects) resolve to UNRESOLVED rather than throwing --
 * a throw in a build loop invites a catch that swallows it.
 */
export function resolveRights(source, field) {
    const src = normalise(source);
    const fld = normalise(field);

    if (!src || !fld) {
        return { publishable: false, rights_state: STATE_UNRESOLVED, plane: null,
            source: src || null, field: fld || null,
            reason: 'missing_source_or_field' };
    }
    if (WITHHELD_SOURCES.has(src)) {
        return { publishable: false, rights_state: STATE_WITHHELD, plane: null,
            source: src, field: fld, reason: 'source_withheld_by_ruling' };
    }
    const allow = ADJUDICATED_FIELDS[src];
    if (!allow) {
        return { publishable: false, rights_state: STATE_UNRESOLVED, plane: null,
            source: src, field: fld, reason: 'source_not_adjudicated' };
    }
    if (!allow.has(fld)) {
        return { publishable: false, rights_state: STATE_UNRESOLVED, plane: null,
            source: src, field: fld, reason: 'field_not_adjudicated' };
    }
    const plane = SOURCE_TO_PLANE[src];
    const meta = PLANES[plane];
    return {
        publishable: true,
        rights_state: meta.rights_state,
        plane,
        source: src,
        field: fld,
        licence: meta.licence,
        licence_url: meta.licence_url,
        attribution: meta.attribution,
        obligations: meta.obligations,
        reason: 'adjudicated',
    };
}

/**
 * Attach the rights envelope to a content unit AT BUILD TIME.
 *
 * The unit carries its own rights afterwards. It does not depend on a
 * serializer remembering to filter, which is the failure mode this replaces.
 * `capture_ref` and `source_pointer` are required by Gate-5B on all 25 fields;
 * their absence is recorded rather than silently tolerated.
 */
export function attachRights(unit) {
    if (!unit || typeof unit !== 'object') {
        return { value: null, rights: resolveRights(null, null),
            traceable: false, publishable: false };
    }
    const rights = resolveRights(unit.source, unit.field);
    const traceable = Boolean(unit.capture_ref) && Boolean(unit.source_pointer);
    return {
        ...unit,
        rights,
        traceable,
        // Publishable requires BOTH an adjudicated right AND traceability.
        publishable: rights.publishable && traceable,
        ...(rights.publishable && !traceable
            ? { publish_block_reason: 'missing_capture_ref_or_source_pointer' }
            : {}),
    };
}

/**
 * Fail-closed gate for any public surface.
 *
 * Returns the units that may be published and an explicit, itemised record of
 * everything refused. The refusals are RETURNED, never swallowed: a rights
 * filter that drops silently is how the original defect stayed invisible.
 */
export function filterPublishable(units) {
    const publishable = [];
    const refused = [];
    for (const raw of Array.isArray(units) ? units : []) {
        const u = attachRights(raw);
        if (u.publishable) publishable.push(u);
        else {
            refused.push({
                source: u.rights?.source ?? null,
                field: u.rights?.field ?? null,
                rights_state: u.rights?.rights_state ?? STATE_UNRESOLVED,
                reason: u.publish_block_reason ?? u.rights?.reason ?? 'unknown',
            });
        }
    }
    return { publishable, refused, refused_count: refused.length };
}
