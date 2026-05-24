/**
 * Open Targets compound-entity merger (cycle 23 PR-OT-4).
 *
 * Pure-function merge of an OT bulk record (one drug entry from
 * processed/bulk/open-targets/<release>/drug-enriched.jsonl.zst as
 * produced by PR-OT-3c) into the compound entity from
 * compounds-enriched.jsonl. ChEMBL ID is the join key.
 *
 * The merge is IDEMPOTENT: re-running stage-3 multiple times against
 * the same OT release produces byte-identical compound output. This
 * is achieved by:
 *   - Object spread for known_drug_info (last-write-wins on each field,
 *     OT data deterministic per release)
 *   - target_associations source-tag filter then concat (avoid drift
 *     across re-runs)
 *   - provenance.sources lookup + update (single entry per source)
 *
 * Per [[researcher_needs_anchor]] the merge is the moment researcher
 * experience changes from "OT data exists somewhere in R2" to "API
 * query compound returns OT-enriched record". Therefore the merge
 * must populate known_drug_info + target_associations on every
 * matching compound, not just a sample.
 *
 * Per [[license_governance]]: license_metadata propagation is per
 * sub-field so downstream consumers (snapshot builder, API responses)
 * can audit which fields carry which upstream license.
 */

const OT_TARGET_SOURCE_TAG = 'open_targets_clinical';

/**
 * Merge one OT bulk record into a compound entity. Returns the mutated
 * compound (also mutates in place for callers walking a JSONL stream).
 * No-op if either input is missing or chembl_id mismatches.
 */
export function mergeOtIntoCompound(compound, otRecord) {
    if (!compound || !otRecord) return compound;
    if (!compound.chembl_id || compound.chembl_id !== otRecord.chembl_id) {
        return compound;
    }

    if (otRecord.known_drug_info) {
        compound.known_drug_info = {
            ...(compound.known_drug_info || {}),
            ...otRecord.known_drug_info,
        };
        compound.known_drug_info_license = otRecord.license_metadata;
    }

    if (Array.isArray(otRecord.target_associations) && otRecord.target_associations.length > 0) {
        const nonOt = (compound.target_associations || []).filter(
            t => t && t.source !== OT_TARGET_SOURCE_TAG,
        );
        compound.target_associations = [...nonOt, ...otRecord.target_associations];
        compound.target_associations_license = otRecord.license_metadata;
    }

    if (!compound.provenance) compound.provenance = {};
    if (!Array.isArray(compound.provenance.sources)) compound.provenance.sources = [];
    const otSourceEntry = {
        source: 'open_targets',
        source_id: otRecord.chembl_id,
        ingested_at: otRecord.license_metadata?.ingestion_date ?? null,
        release: otRecord.license_metadata?.upstream_release ?? null,
    };
    const ix = compound.provenance.sources.findIndex(s => s && s.source === 'open_targets');
    if (ix >= 0) {
        compound.provenance.sources[ix] = otSourceEntry;
    } else {
        compound.provenance.sources.push(otSourceEntry);
    }

    return compound;
}

/**
 * Build a Map<chembl_id, otRecord> from a list of OT bulk records.
 * Skips records with missing/non-string chembl_id (they cannot match
 * any compound; OT bulk should not emit such rows but the index
 * filters defensively).
 */
export function buildOtIndex(otRecords) {
    const index = new Map();
    let skipped = 0;
    for (const rec of otRecords) {
        if (!rec || typeof rec.chembl_id !== 'string' || rec.chembl_id.length === 0) {
            skipped++;
            continue;
        }
        index.set(rec.chembl_id, rec);
    }
    return { index, skipped };
}

/**
 * Walk an array of compounds, merging matching OT records in place.
 * Returns counters for stage-3 logging.
 */
export function mergeOtAcrossCompounds(compounds, otIndex) {
    let matched = 0;
    let chemblIdPresent = 0;
    for (const compound of compounds) {
        if (typeof compound?.chembl_id !== 'string' || compound.chembl_id.length === 0) continue;
        chemblIdPresent++;
        const otRec = otIndex.get(compound.chembl_id);
        if (otRec) {
            mergeOtIntoCompound(compound, otRec);
            matched++;
        }
    }
    return { matched, chemblIdPresent, totalCompounds: compounds.length };
}
