/**
 * Open Targets ingest helpers (cycle 23 PR-OT-3).
 *
 * Pure-function transformers separated from the harvest orchestrator so
 * the row-to-record mapping is unit-testable independent of DuckDB / R2
 * IO. open-targets-harvest.js drives the orchestration; this module
 * defines the contract between the OT drug_molecule Parquet schema
 * (captured by PR-OT-1 probe 2026-05-24) and the Sciweon compound
 * entity field shape (locked by PR-OT-2 source-required-fields.js).
 *
 * Why the separation: PR-OT-3b will join four more OT tables
 * (drug_indication, drug_mechanism_of_action, drug_warning, known_drug)
 * into known_drug_info; the row-to-record transform will need to merge
 * inputs from multiple sources. Keeping the transform here, off the IO
 * path, lets that future merge land without re-touching the harvester.
 */

const ENTITY_ID_PREFIX = 'sciweon::ot-drug::';

/**
 * Transform one OT drug_molecule Parquet row into a Sciweon OT-bulk
 * record. The output shape lands as one JSON line in
 * processed/bulk/open-targets/<release>/drug-molecule.jsonl.zst and is
 * consumed by PR-OT-4 stage-3-aggregate.js for merge into the compound
 * entity via the ChEMBL ID join key.
 *
 * Input row shape (captured 2026-05-24 via PR-OT-1 DuckDB DESCRIBE):
 *   id VARCHAR (ChEMBL ID, e.g. "CHEMBL1000") - REQUIRED
 *   canonicalSmiles VARCHAR | null
 *   inchiKey VARCHAR | null
 *   drugType VARCHAR | null
 *   name VARCHAR | null
 *   parentId VARCHAR | null
 *   tradeNames VARCHAR[] | null
 *   synonyms VARCHAR[] | null
 *   crossReferences STRUCT(source VARCHAR, ids VARCHAR[])[] | null
 *   childChemblIds VARCHAR[] | null
 *   maximumClinicalStage VARCHAR | null
 *   description VARCHAR | null
 *
 * Throws on missing/non-string id (would corrupt the Sciweon entity ID
 * deterministic-construction guarantee per DATA_ARCH section 3.0).
 */
export function openTargetsRowToSciweonRecord(row, release, ingestionDate) {
    if (!row || typeof row.id !== 'string' || row.id.length === 0) {
        throw new Error('[OT-INGEST] invalid row: missing or non-string id');
    }
    const chemblId = row.id;
    return {
        id: `${ENTITY_ID_PREFIX}${chemblId}`,
        chembl_id: chemblId,
        known_drug_info: {
            chembl_id: chemblId,
            name: row.name ?? null,
            drug_type: row.drugType ?? null,
            canonical_smiles: row.canonicalSmiles ?? null,
            inchi_key: row.inchiKey ?? null,
            parent_chembl_id: row.parentId ?? null,
            trade_names: Array.isArray(row.tradeNames) ? row.tradeNames : [],
            synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
            child_chembl_ids: Array.isArray(row.childChemblIds) ? row.childChemblIds : [],
            max_clinical_stage: row.maximumClinicalStage ?? null,
            description: row.description ?? null,
        },
        cross_references: normalizeCrossReferences(row.crossReferences),
        license_metadata: {
            upstream_source: 'open_targets',
            upstream_license: 'cc0-1.0',
            upstream_release: release,
            ingestion_date: ingestionDate,
        },
    };
}

/**
 * Normalize OT crossReferences STRUCT array to a clean source/ids list.
 * Drops malformed entries (non-string source, non-array ids, empty ids)
 * and non-string elements inside ids. PR-OT-4 stage-3 merge relies on
 * this for the PubChem CID xref preferred over UniChem bridge.
 */
function normalizeCrossReferences(refs) {
    if (!Array.isArray(refs)) return [];
    return refs
        .filter(r => r && typeof r.source === 'string' && Array.isArray(r.ids))
        .map(r => ({ source: r.source, ids: r.ids.filter(id => typeof id === 'string' && id.length > 0) }))
        .filter(r => r.ids.length > 0);
}

/**
 * Build the OT cursor record persisted to R2 state/open-targets-cursor.json.
 * PR-OT-5 quarterly cron uses release_version + last_success_at to decide
 * whether to re-ingest. PR-OT-4 stage-3 merge uses r2_key to locate the
 * latest bulk artifact.
 */
export function buildCursorRecord({
    release, recordCount,
    byteSizeUncompressed, byteSizeCompressed,
    ingestedAt,
}) {
    return {
        source: 'open_targets',
        release_version: release,
        last_success_at: ingestedAt,
        record_count: recordCount,
        byte_size_uncompressed: byteSizeUncompressed,
        byte_size_compressed: byteSizeCompressed,
        r2_key: `processed/bulk/open-targets/${release}/drug-molecule.jsonl.zst`,
        schema_version: 'pr-ot-3',
    };
}
