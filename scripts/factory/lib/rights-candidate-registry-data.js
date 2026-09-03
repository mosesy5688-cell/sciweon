/**
 * rights-candidate-registry-data.js -- the frozen Gate-5B adjudicated rights
 * facts, held in module-closure scope behind value-returning accessors.
 *
 * WHAT THIS IS: a registry of adjudicated rights facts, and nothing more.
 *
 * WHAT THIS IS NOT: rights enforcement, a publication authority, or a
 * description of any control operating in production today. No state produced
 * anywhere in this lane is a permission. Nothing here is wired to a serving or
 * a packaging path. The separation of the three groups below is a LOGICAL
 * PARTITION only: three arrays returned from one module, in one process, in
 * one heap. See module_limits, which states that limit positively.
 *
 * PROVENANCE of the 25 pairs:
 *   archive : SCIWEON_GATE5B_ROUND11_EVIDENCE.zip
 *   bytes   : 11,679,973
 *   sha256  : c513da40cc1a8e17283a730293c8ad9cb0df4858e49c649b8091561bf50b20ce
 * A partial digest of that archive, or of any rights input, is never accepted,
 * reconstructed or invented.
 *
 * TWO NAMESPACES: the 25 names below are the rights-adjudication namespace.
 * They are not the pipeline schema names. `connectivity_smiles` here denotes
 * the same chemical fact the pipeline calls `smiles_canonical`, and both are
 * correct in their own namespace. `source-required-fields.js` in this same
 * directory is a pipeline-integrity registry, not a rights registry, and is
 * not reconciled against this file in either direction.
 *
 * VOCABULARY RULE, carried in prose because a regex cannot carry it: do not
 * introduce synonyms of the guarded stems -- "air-gapped", "segregated",
 * "quarantined", "separate memory" and the like. The guard pattern cannot be
 * widened to catch them, because two module_limits keys legitimately contain
 * the substring "separat". Reword the prose instead; never weaken the guard.
 */

const KEY_SEPARATOR = ' ';

const PLANE_DEFS = [
    {
        plane_id: 'CLEAN_COMMERCIAL',
        source: 'pubchem',
        rights_state: 'CLEAN_COMMERCIAL_FIELD_QUALIFIED',
        public_label: 'FIELD-QUALIFIED PUBLIC',
        licence: null,
        grants_unconditional_commercial_use: false,
        attribution: ['PubChem', 'NIH/NCBI'],
        fields: [
            'pubchem_cid', 'inchi_key', 'molecular_formula',
            'connectivity_smiles', 'iupac_name',
        ],
    },
    {
        plane_id: 'LICENSED_SHAREALIKE',
        source: 'chembl',
        rights_state: 'LICENSED_SHAREALIKE',
        public_label: 'SHARE-ALIKE',
        licence: 'CC BY-SA 3.0 Unported',
        grants_unconditional_commercial_use: false,
        attribution: ['ChEMBL', 'EMBL-EBI'],
        fields: [
            'chembl_db_version', 'chembl_release_date', 'chembl_target_id',
            'chembl_id', 'assay_chembl_id', 'assay_description',
            'assay_organism', 'standard_type', 'standard_relation',
            'standard_value', 'standard_units', 'pchembl_value',
            'source_record_activity_id', 'document_chembl_id',
        ],
    },
    {
        plane_id: 'BIBLIOGRAPHIC',
        source: 'pubmed',
        rights_state: 'NO_LICENCE_GRANTED_ATTRIBUTION_REQUIRED',
        public_label: 'BIBLIOGRAPHIC',
        licence: null,
        grants_unconditional_commercial_use: false,
        attribution: ['Courtesy of the U.S. National Library of Medicine'],
        fields: ['pmid', 'doi', 'journal', 'pubdate', 'volume', 'pages'],
    },
];

/**
 * Declared, never executed. Every obligation carries enforced: false and
 * discharged_by_this_module: false, permanently. ALL_PLANES attaches to every
 * adjudicated pair regardless of plane.
 */
const OBLIGATION_DEFS = [
    { id: 'ATTRIBUTION_REQUIRED_PUBCHEM_NIH_NCBI', applies_to: 'CLEAN_COMMERCIAL' },
    { id: 'DEPOSITOR_CONTRIBUTED_TERMS_MAY_APPLY', applies_to: 'CLEAN_COMMERCIAL' },
    { id: 'ATTRIBUTION_REQUIRED_EMBL_EBI', applies_to: 'LICENSED_SHAREALIKE' },
    { id: 'SHARE_ALIKE_CC_BY_SA_3_0_UNPORTED', applies_to: 'LICENSED_SHAREALIKE' },
    {
        id: 'COLLECTION_VS_ADAPTATION_BOUNDARY_REVIEW_REQUIRED',
        applies_to: 'LICENSED_SHAREALIKE', boundary_settled: false,
    },
    { id: 'ATTRIBUTION_REQUIRED_NLM_COURTESY', applies_to: 'BIBLIOGRAPHIC' },
    { id: 'CURRENCY_DISCLOSURE_REQUIRED_ON_REPUBLICATION', applies_to: 'BIBLIOGRAPHIC' },
    { id: 'COMPLY_WITH_MOST_RESTRICTIVE_UPSTREAM_TERMS', applies_to: 'ALL_PLANES' },
];

/** Gate-5B placed no field from these four sources into any output plane. */
const SOURCES_WITHOUT_PLANE_MEMBERSHIP = ['uniprot', 'unichem', 'meddra', 'kegg'];

const MODULE_LIMITS_DEF = {
    separation_model: 'LOGICAL_PARTITION',
    separation_proven_by_packaging_artifact: false,
    packaging_cross_plane_rejection_tests_present: false,
    end_to_end: false,
    wired_to_serving_path: false,
    wired_to_packaging_path: false,
};

/**
 * The single exported constant read by layers 3 and 4 of the vocabulary guard.
 * It is the eight pre-approved rights-* paths minus exactly one:
 * tests/factory/rights-vocabulary-guard.test.ts, which must contain the
 * pattern literal to work and is the single exemption.
 */
export const GUARDED_FILES = Object.freeze([
    'scripts/factory/lib/rights-candidate-registry-data.js',
    'scripts/factory/lib/rights-candidate-assessor.js',
    'scripts/factory/lib/rights-manifest-consistency.js',
    'tests/factory/rights-candidate-registry-data.test.ts',
    'tests/factory/rights-candidate-assessor.test.ts',
    'tests/factory/rights-manifest-consistency.test.ts',
    'tests/factory/rights-immutability.test.ts',
]);

function deepFreeze(value, seen) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key], seen);
    return value;
}

/** Returns a fresh, deeply frozen copy. Callers never receive a live collection. */
function frozenCopy(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) out[key] = frozenCopy(value[key]);
        return Object.freeze(out);
    }
    return value;
}

function buildObligation(def) {
    const out = {
        id: def.id, applies_to: def.applies_to,
        enforced: false, discharged_by_this_module: false,
    };
    if (def.boundary_settled !== undefined) out.boundary_settled = def.boundary_settled;
    return out;
}

const PLANES = deepFreeze(PLANE_DEFS.map((p) => ({ ...p })), new WeakSet());
const OBLIGATIONS = deepFreeze(OBLIGATION_DEFS.map(buildObligation), new WeakSet());
const FROZEN_SOURCES = deepFreeze([...SOURCES_WITHOUT_PLANE_MEMBERSHIP], new WeakSet());
const MODULE_LIMITS = deepFreeze({ ...MODULE_LIMITS_DEF }, new WeakSet());

/** Composite index. The key is the pair; no lookup can take a field alone. */
const PAIR_INDEX = new Map();
for (const plane of PLANES) {
    for (const field of plane.fields) {
        PAIR_INDEX.set(plane.source + KEY_SEPARATOR + field, plane.plane_id);
    }
}

function pairKey(source, field) {
    if (typeof source !== 'string' || typeof field !== 'string') return null;
    if (source === '' || field === '') return null;
    return source + KEY_SEPARATOR + field;
}

export function has(source, field) {
    const key = pairKey(source, field);
    return key !== null && PAIR_INDEX.has(key);
}

export function planeOf(source, field) {
    const key = pairKey(source, field);
    if (key === null) return null;
    const planeId = PAIR_INDEX.get(key);
    return planeId === undefined ? null : planeId;
}

export function planeRecord(planeId) {
    const found = PLANES.find((p) => p.plane_id === planeId);
    return found === undefined ? null : frozenCopy(found);
}

export function planeIds() {
    return Object.freeze(PLANES.map((p) => p.plane_id));
}

export function snapshot() {
    const rows = [];
    for (const plane of PLANES) {
        for (const field of plane.fields) {
            rows.push({
                source: plane.source, field,
                plane: plane.plane_id, rights_state: plane.rights_state,
            });
        }
    }
    return frozenCopy(rows);
}

export function allObligations() {
    return frozenCopy(OBLIGATIONS);
}

export function obligationsForPlane(planeId) {
    if (!PLANES.some((p) => p.plane_id === planeId)) return Object.freeze([]);
    return frozenCopy(
        OBLIGATIONS.filter((o) => o.applies_to === planeId || o.applies_to === 'ALL_PLANES'),
    );
}

export function sourcesWithoutPlaneMembership() {
    return frozenCopy(FROZEN_SOURCES);
}

export function isSourceWithoutPlaneMembership(source) {
    return typeof source === 'string' && FROZEN_SOURCES.includes(source);
}

export function moduleLimits() {
    return frozenCopy(MODULE_LIMITS);
}

/**
 * Aggregate guard: the count is never returned on its own. Any reader of a
 * total also receives the undischarged obligations attached to it, so a count
 * cannot be read as a clearance count.
 */
export function count() {
    const byPlane = {};
    for (const plane of PLANES) byPlane[plane.plane_id] = plane.fields.length;
    return frozenCopy({
        total: PAIR_INDEX.size,
        by_plane: byPlane,
        obligations: OBLIGATIONS,
    });
}
