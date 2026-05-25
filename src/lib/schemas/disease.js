/**
 * Disease entity schema — Sciweon V0.1 / cycle 23 PR-SID-1.6b-pre.1b.
 *
 * Disease (clinical condition / phenotype / biological attribute) sourced from
 * Open Targets ontology aggregation. Identity anchor per PR-SID-1.6b precedent:
 * **per-namespace multi-canonicalization-version protocol** (Plan A1 lock
 * 2026-05-25), reflecting OT 26.03 real-world disease.id distribution:
 *
 *   OBA      37.08%   Ontology of Biological Attributes (phenotypes/attributes)
 *   MONDO    27.18%   Monarch Disease Ontology
 *   EFO      25.36%   Experimental Factor Ontology
 *   HP        4.92%   Human Phenotype Ontology
 *   Orphanet  4.34%   Rare disease ontology
 *   tail     <1.01%   GO / DOID / NCIT / GSSO / OTAR / OBI / MP / PATO / OGMS / UBERON
 *
 * 5 first-class namespaces (OBA, MONDO, EFO, HP, Orphanet) each get a distinct
 * canonicalization_version so version bumps stay modular per namespace. Tail
 * routes to a single `unclassified_ontology` fuse to avoid unbounded canon
 * proliferation while keeping 100% corpus coverage (rejecting Plan A2 strict-
 * skip and Plan A3 monolithic-canon).
 *
 * Anchor payload format:
 *   Primary (5 namespaces): `<ns>:<numeric_id>`     e.g. `mondo:0000005`
 *   Tail fuse:              `unclassified_ontology:<RAW_ID>`
 *                                                    e.g. `unclassified_ontology:DOID_0050890`
 *
 * SID-S derivation:
 *   sha256(`sciweon:disease:<canon_version>:<anchor_payload>`).hex[:32]
 *
 * Frozen reference SID-S pins (execution-gate verified 2026-05-25 for PR-1.6b
 * stamper test pinning — NOT used directly by linker but documented here for
 * cross-PR traceability):
 *   EFO_0000094              -> bbe589ace6048150231646c7dfdc510b
 *   MONDO_0000005            -> ca10368a6f87a07e0bcd9c9c0ad1cd4b
 *   OBA_0000015              -> 97e43da8376555aaa21763667619097a
 *   HP_0000002               -> 56b568ff785d279acde583e08d0dfa56
 *   Orphanet_100             -> 88f2c9c94c3c04de40aa1800aba9db43
 *   DOID_0050890 (tail-fuse) -> 73c43a1559327b12fb7063d719104da0
 */

export const DISEASE_ID_PREFIX = 'sciweon::disease::';

/**
 * 5 first-class namespaces. Map key is case-preserved OT raw prefix (the form
 * appearing in OT `disease.id`); map value is the lowercased Sciweon namespace
 * identifier used in anchor_payload + canon_version.
 */
export const PRIMARY_NAMESPACE_MAP = Object.freeze({
    OBA: 'oba',
    MONDO: 'mondo',
    EFO: 'efo',
    HP: 'hp',
    Orphanet: 'orphanet',
});

/**
 * Tail-fuse umbrella: any disease_id whose prefix is NOT in
 * PRIMARY_NAMESPACE_MAP routes here. Preserves 100% corpus coverage while
 * isolating low-frequency long-tail ontologies from the 5 first-class
 * canon-version tracks.
 */
export const TAIL_FUSE_NAMESPACE = 'unclassified_ontology';

/** Canonicalization version per namespace (PR-SID-1.6b lock). */
export const CANON_VERSIONS = Object.freeze({
    oba: 'disease.oba.v1.0',
    mondo: 'disease.mondo.v1.0',
    efo: 'disease.efo.v1.0',
    hp: 'disease.hp.v1.0',
    orphanet: 'disease.orphanet.v1.0',
    unclassified_ontology: 'disease.unclassified_ontology.v1.0',
});

// Regex: split on FIRST underscore. Prefix = `[A-Za-z]+`, suffix = remainder.
// Defensive: rejects empty prefix, empty suffix, non-letter prefix chars.
const DISEASE_ID_SPLIT_PATTERN = /^([A-Za-z]+)_(.+)$/;

/**
 * Pure-function parser: decompose an OT raw disease_id into its namespace +
 * canon_version + anchor_payload + Sciweon-namespaced id.
 *
 * Returns `null` for invalid input (non-string / empty / no `[A-Za-z]+_<rest>`
 * pattern). The linker treats null as `unparseable_disease_id` skip with
 * explicit telemetry count (NOT silent drop per [[cross_cycle_silent_data_loss]]).
 *
 * Primary routing: case-sensitive prefix match against PRIMARY_NAMESPACE_MAP.
 * Tail-fuse routing: any other letter-only prefix → namespace=unclassified_ontology,
 * anchor_payload preserves the FULL raw id (case + underscore) for downstream
 * disambiguation across long-tail ontologies sharing the same Sciweon namespace.
 */
export function parseDiseaseIdNamespace(rawDiseaseId) {
    if (typeof rawDiseaseId !== 'string') return null;
    const trimmed = rawDiseaseId.trim();
    if (trimmed.length === 0) return null;
    const match = trimmed.match(DISEASE_ID_SPLIT_PATTERN);
    if (!match) return null;
    const rawPrefix = match[1];
    const suffix = match[2];
    if (suffix.length === 0) return null;

    if (Object.prototype.hasOwnProperty.call(PRIMARY_NAMESPACE_MAP, rawPrefix)) {
        const namespace = PRIMARY_NAMESPACE_MAP[rawPrefix];
        const anchorPayload = `${namespace}:${suffix}`;
        return {
            namespace,
            numeric_id: suffix,
            ontology_prefix: rawPrefix,
            anchor_payload: anchorPayload,
            canonicalization_version: CANON_VERSIONS[namespace],
            sciweon_id: `${DISEASE_ID_PREFIX}${anchorPayload}`,
        };
    }

    // Tail-fuse: preserve full raw id in anchor_payload to prevent collisions
    // across long-tail ontologies (e.g. NCIT_C117245 vs DOID_0050890).
    const anchorPayload = `${TAIL_FUSE_NAMESPACE}:${trimmed}`;
    return {
        namespace: TAIL_FUSE_NAMESPACE,
        numeric_id: suffix,
        ontology_prefix: rawPrefix,
        anchor_payload: anchorPayload,
        canonicalization_version: CANON_VERSIONS[TAIL_FUSE_NAMESPACE],
        sciweon_id: `${DISEASE_ID_PREFIX}${anchorPayload}`,
    };
}

export const DISEASE_SCHEMA = {
    id: { type: 'string', required: true, pattern: /^sciweon::disease::/ },
    raw_disease_id: { type: 'string', required: true, maxLength: 200 },
    namespace: {
        type: 'string', required: true,
        enum: ['oba', 'mondo', 'efo', 'hp', 'orphanet', 'unclassified_ontology'],
    },
    ontology_prefix: { type: 'string', required: true, maxLength: 50 },
    numeric_id: { type: 'string', required: true, maxLength: 200 },
    anchor_payload: { type: 'string', required: true, maxLength: 250 },
    canonicalization_version: {
        type: 'string', required: true,
        enum: [
            'disease.oba.v1.0', 'disease.mondo.v1.0', 'disease.efo.v1.0',
            'disease.hp.v1.0', 'disease.orphanet.v1.0',
            'disease.unclassified_ontology.v1.0',
        ],
    },
    name: { type: 'string', required: false, maxLength: 1000 },
    description: { type: 'string', required: false, maxLength: 10000 },
    synonyms: {
        type: 'object', required: false,
        shape: {
            has_exact_synonym: { type: 'array', itemType: 'string' },
            has_related_synonym: { type: 'array', itemType: 'string' },
            has_broad_synonym: { type: 'array', itemType: 'string' },
            has_narrow_synonym: { type: 'array', itemType: 'string' },
        },
    },
    therapeutic_areas: { type: 'array', required: false, itemType: 'string' },
    parents: { type: 'array', required: false, itemType: 'string' },
    ancestors: { type: 'array', required: false, itemType: 'string' },
    db_xrefs: { type: 'array', required: false, itemType: 'string' },
    code: { type: 'string', required: false, maxLength: 500 },
    provenance: {
        type: 'object', required: true,
        shape: {
            sources: {
                type: 'array', required: true, minItems: 1,
                items: {
                    source: { type: 'string', required: true, enum: ['open_targets'] },
                    source_id: { type: 'string', required: true, maxLength: 200 },
                    timestamp: { type: 'string', required: true, format: 'iso8601' },
                },
            },
            last_updated: { type: 'string', required: true, format: 'iso8601' },
        },
    },
    license_metadata: {
        type: 'object', required: false,
        shape: {
            upstream_source: { type: 'string' },
            upstream_license: { type: 'string' },
            upstream_release: { type: 'string' },
            ingestion_date: { type: 'string' },
        },
    },
};
