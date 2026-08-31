/**
 * F0-RIGHTS-REGISTRY -- the Gate-5B frozen rights registry (PRIMITIVE ONLY).
 *
 * NAMING, DELIBERATELY. This module is a rights REGISTRY and a candidate
 * ASSESSOR. It is NOT "rights enforcement". Enforcement would mean a control
 * that actually prevents a non-compliant byte from leaving; nothing here is
 * wired into a serving or packaging path, and the obligations it reports are
 * DECLARED METADATA, not executed behaviour. Calling it enforcement would
 * overstate the system in exactly the way the public-surface corrections had
 * to undo.
 *
 * WHAT IT IMPLEMENTS
 *
 * Exactly the 25 rights-bearing fields and three data planes that Gate-5B
 * adjudicated and froze. Nothing else. It does not infer and does not
 * generalise from a source that "looks open". A field that was not
 * adjudicated is UNRESOLVED, and unresolved fails closed.
 *
 * WHY FAIL-CLOSED IS THE POINT
 *
 * The pre-existing containment (`src/worker/lib/source-rights-filter.ts`) is a
 * DENYLIST applied at serialization: it removes shapes it recognises, and an
 * unrecognised source, a renamed field or a reshaped payload passes through.
 * This registry inverts that.
 *
 * FOUR CORRECTIONS APPLIED AFTER FOUNDER REVIEW
 *
 * 1. A self-declared tuple is NOT publishable. Previously any caller supplying
 *    an allowed source/field plus two non-empty strings got `publishable`.
 *    That is self-certification -- the subject asserting its own compliance.
 *    `assessRights()` now returns a CANDIDATE whose terminal state is
 *    REQUIRES_MANIFEST_VERIFICATION until an independent manifest confirms it.
 * 2. The manifest is actually checked: the ref must resolve, the resolved
 *    capture's source must MATCH the declared source, and the pointer must be
 *    recorded against it. See `rights-manifest-verify.js`.
 * 3. Planes are returned PHYSICALLY DISTINCT. One flat array would re-mix what
 *    Gate-5B required kept apart; share-alike must not join the clean plane.
 * 4. Obligations are DECLARED, not enforced. Each carries `enforced: false` so
 *    a description cannot be mistaken for a control.
 *
 * PROVENANCE: the 25 fields were extracted read-only from the immutable
 * Round-11 evidence (sha256 c513da40...), TRUTH_REPAIR_v1.2 plane outputs.
 * Counts reconcile with the Decision Log: 5 + 14 + 6 = 25.
 * DO NOT ADD A FIELD WITHOUT A FOUNDER RULING.
 */

import { verifyAgainstManifest } from './rights-manifest-verify.js';

export { verifyAgainstManifest };

export const PLANE_CLEAN_COMMERCIAL = 'CLEAN_COMMERCIAL';
export const PLANE_LICENSED_SHAREALIKE = 'LICENSED_SHAREALIKE';
export const PLANE_BIBLIOGRAPHIC = 'BIBLIOGRAPHIC';

export const STATE_UNRESOLVED = 'RIGHTS_UNRESOLVED';
export const STATE_NOT_IN_APPROVED_PLANE = 'NOT_IN_ANY_APPROVED_OUTPUT_PLANE';
export const STATE_REQUIRES_VERIFICATION = 'REQUIRES_MANIFEST_VERIFICATION';
export const STATE_VERIFIED = 'MANIFEST_VERIFIED';

/** This module is a primitive. It is not wired to any serving path. */
export const ENFORCEMENT_STATUS = Object.freeze({
    end_to_end: false,
    wired_into_serving_path: false,
    wired_into_packaging_path: false,
    note: 'Registry and candidate assessor only. Obligations reported here are '
        + 'DECLARED metadata, not executed controls. Nothing in this module '
        + 'prevents a byte from being served or packaged.',
});

function obligation(name) {
    // `enforced: false` on every obligation, because none of them are.
    return Object.freeze({ obligation: name, enforced: false });
}

export const PLANES = Object.freeze({
    [PLANE_CLEAN_COMMERCIAL]: Object.freeze({
        rights_state: 'CLEAN_COMMERCIAL_FIELD_QUALIFIED',
        source: 'pubchem',
        licence: null,
        licence_url: null,
        attribution: 'PubChem, NIH/NCBI',
        obligations: Object.freeze([
            obligation('field_qualified_only'),
            obligation('no_unconditional_commercial_grant'),
        ]),
    }),
    [PLANE_LICENSED_SHAREALIKE]: Object.freeze({
        rights_state: 'LICENSED_SHAREALIKE',
        source: 'chembl',
        licence: 'CC BY-SA 3.0 Unported',
        licence_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
        attribution: 'ChEMBL, EMBL-EBI',
        obligations: Object.freeze([
            obligation('attribution'),
            obligation('share_alike'),
            obligation('physically_separate_plane'),
        ]),
    }),
    [PLANE_BIBLIOGRAPHIC]: Object.freeze({
        rights_state: 'NO_LICENCE_GRANTED_ATTRIBUTION_REQUIRED',
        source: 'pubmed',
        licence: null,
        licence_url: null,
        attribution: 'Courtesy of the U.S. National Library of Medicine',
        obligations: Object.freeze([
            obligation('attribution'),
            obligation('currency_disclosure_on_republication'),
        ]),
    }),
});

/**
 * Genuinely immutable membership set. `Object.freeze(new Set([...]))` does NOT
 * work: freeze seals own properties while a Set's contents live in internal
 * slots, so `.add()` still succeeds silently. A "frozen" allowlist that can be
 * extended at runtime is worse than none, because it reads as a guarantee.
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
    pubmed: frozenSet(['pmid', 'doi', 'journal', 'pubdate', 'volume', 'pages']),
});

const SOURCE_TO_PLANE = Object.freeze({
    pubchem: PLANE_CLEAN_COMMERCIAL,
    chembl: PLANE_LICENSED_SHAREALIKE,
    pubmed: PLANE_BIBLIOGRAPHIC,
});

/**
 * Sources with no field in any approved output plane. Gate-5B placed nothing
 * from UniProt or UniChem into a plane; MedDRA and KEGG are the RC-3A
 * restricted families.
 */
export const NOT_IN_APPROVED_PLANE = frozenSet(['uniprot', 'unichem', 'meddra', 'kegg']);

export const TOTAL_ADJUDICATED_FIELDS = Object.values(ADJUDICATED_FIELDS)
    .reduce((n, s) => n + s.size, 0);

function normalise(s) {
    return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/** Does the adjudication permit this (source, field) at all? Step one of two. */
export function resolveRights(source, field) {
    const src = normalise(source);
    const fld = normalise(field);
    const base = { source: src || null, field: fld || null, plane: null, adjudicated: false };
    if (!src || !fld) return { ...base, rights_state: STATE_UNRESOLVED, reason: 'missing_source_or_field' };
    if (NOT_IN_APPROVED_PLANE.has(src)) {
        return { ...base, rights_state: STATE_NOT_IN_APPROVED_PLANE, reason: 'no_field_in_any_approved_plane' };
    }
    const allow = ADJUDICATED_FIELDS[src];
    if (!allow) return { ...base, rights_state: STATE_UNRESOLVED, reason: 'source_not_adjudicated' };
    if (!allow.has(fld)) return { ...base, rights_state: STATE_UNRESOLVED, reason: 'field_not_adjudicated' };
    const plane = SOURCE_TO_PLANE[src];
    const meta = PLANES[plane];
    return {
        source: src, field: fld, plane, adjudicated: true,
        rights_state: meta.rights_state,
        licence: meta.licence, licence_url: meta.licence_url,
        attribution: meta.attribution, obligations: meta.obligations,
        reason: 'adjudicated',
    };
}

/**
 * Assess a content unit. Returns a CANDIDATE, never a self-certified pass.
 *
 * Correction 1: with no manifest the terminal state is
 * REQUIRES_MANIFEST_VERIFICATION. A caller cannot make its own tuple
 * publishable by asserting it.
 */
export function assessRights(unit, manifest) {
    if (!unit || typeof unit !== 'object') {
        return {
            rights: resolveRights(null, null),
            verification: { verified: false, reason: 'not_an_object' },
            terminal_state: STATE_UNRESOLVED,
            publishable: false,
            enforcement: ENFORCEMENT_STATUS,
        };
    }
    const rights = resolveRights(unit.source, unit.field);
    const verification = verifyAgainstManifest(unit, manifest);
    const terminal = !rights.adjudicated
        ? rights.rights_state
        : (verification.verified ? STATE_VERIFIED : STATE_REQUIRES_VERIFICATION);
    return {
        ...unit,
        rights,
        verification,
        terminal_state: terminal,
        publishable: rights.adjudicated && verification.verified,
        enforcement: ENFORCEMENT_STATUS,
    };
}

/**
 * Partition units into the three PHYSICALLY DISTINCT planes plus refusals.
 *
 * Correction 3: a single flat array would re-mix planes Gate-5B required to
 * stay separated. The share-alike plane in particular must not be commingled
 * with the clean plane.
 */
export function partitionIntoPlanes(units, manifest) {
    const out = {
        [PLANE_CLEAN_COMMERCIAL]: [],
        [PLANE_LICENSED_SHAREALIKE]: [],
        [PLANE_BIBLIOGRAPHIC]: [],
        refused: [],
        enforcement: ENFORCEMENT_STATUS,
    };
    for (const raw of Array.isArray(units) ? units : []) {
        const a = assessRights(raw, manifest);
        if (a.publishable) out[a.rights.plane].push(a);
        else {
            out.refused.push({
                source: a.rights?.source ?? null,
                field: a.rights?.field ?? null,
                rights_state: a.rights?.rights_state ?? STATE_UNRESOLVED,
                terminal_state: a.terminal_state,
                reason: a.rights?.adjudicated ? a.verification.reason : a.rights.reason,
            });
        }
    }
    out.refused_count = out.refused.length;
    return out;
}
