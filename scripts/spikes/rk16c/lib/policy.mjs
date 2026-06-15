/**
 * RK-16C OFFLINE SPIKE — bioactivity FamilyPolicy (EXPERIMENT, not production).
 *
 * Defines the candidate rk16c family business policy the spike validates:
 *   - canonical identity = the row `id` -> key `sciweon::bioactivity::<id>` ;
 *     1 record = 1 NXVF entity, stored ONCE.
 *   - TWO materialized axes:
 *       compound axis  key = the row compound_id (already sciweon::compound::..)
 *       target axis    key = `chembl:<target_id>` (the REQUIRED top-level
 *                      target_id is the target authority).
 *   - uniprot:<accession> is an OPTIONAL ALIAS resolving to the SAME target
 *     family (only when target.uniprot_accession present). NOT the authority.
 *
 * project(canonical, locator) is a PURE, reproducible function of the canonical
 * record + its locator (re-derivable) and conforms to ProjectionRowBase
 * (canonical_id + canonical_content_hash + projection_schema_version +
 * record_locator) plus the family serving columns. This is a spike artifact:
 * it registers NO family and is NOT imported by production.
 */

import { projectionHash } from '../../../factory/lib/rk16/content-hash.js';

export const RK16C_FAMILY_ID = 'bioactivities';
export const RK16C_PROJECTION_SCHEMA_VERSION = 'rk16c-bioactivity-proj-v1';

/** canonical_id for a bioactivity row (the row `id` IS the entity identity). */
export function canonicalId(record) {
    return String(record.id);
}

/** Compound-axis index key (compound_id is already namespaced). */
export function compoundAxisKey(record) {
    return String(record.compound_id);
}

/** Target-axis AUTHORITY key — derived from the required top-level target_id. */
export function targetAxisKey(record) {
    return `chembl:${String(record.target_id)}`;
}

/**
 * Optional uniprot ALIAS key (resolves to the same target family) — present
 * ONLY when target.uniprot_accession exists. Returns null otherwise. This is an
 * alias, NEVER the target authority.
 */
export function uniprotAliasKey(record) {
    const acc = record.target && record.target.uniprot_accession;
    return acc ? `uniprot:${String(acc)}` : null;
}

/**
 * The rk16c FamilyPolicy. project() is the single source of the projection row;
 * the producer NEVER hand-edits a row. Serving columns are the minimal
 * filterable set a LIST query needs (NO heavy canonical fields are duplicated).
 */
export const rk16cFamilyPolicy = {
    family_id: RK16C_FAMILY_ID,
    projection_schema_version: RK16C_PROJECTION_SCHEMA_VERSION,
    /**
     * @param {object} canonical the canonical bioactivity record
     * @param {object} locator   its RecordLocator (carries content_hash)
     */
    project(canonical, locator) {
        const base = {
            canonical_id: canonicalId(canonical),
            canonical_content_hash: locator.content_hash,
            projection_schema_version: RK16C_PROJECTION_SCHEMA_VERSION,
            record_locator: locator,
            // ── serving columns (filterable; small, no canonical duplication) ──
            compound_id: String(canonical.compound_id),
            target_id: String(canonical.target_id),
            uniprot_accession:
                (canonical.target && canonical.target.uniprot_accession) || null,
            activity_type: canonical.activity_type ?? null,
            is_active: canonical.is_active ?? null,
            value: typeof canonical.value === 'number' ? canonical.value : null,
            unit: canonical.unit ?? null,
        };
        return { ...base, projection_hash: projectionHash(base) };
    },
};

/**
 * Partition NAME functions for the partition experiment. The substrate does NOT
 * hardcode these; the spike (a family business choice) supplies them. P0 = no
 * partition; P1 = by is_active; P2 = by is_active + activity_type.
 */
export const PARTITION_STRATEGIES = {
    P0: { name: 'P0_none', of: () => 'all' },
    P1: { name: 'P1_is_active', of: (r) => `is_active=${String(r.is_active)}` },
    P2: {
        name: 'P2_is_active_x_activity_type',
        of: (r) => `is_active=${String(r.is_active)}|type=${String(r.activity_type)}`,
    },
};
