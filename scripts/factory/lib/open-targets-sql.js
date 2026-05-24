/**
 * Open Targets ingest core (cycle 23 PR-OT-3 + PR-OT-3c).
 *
 * Houses the OT-bulk row -> Sciweon record transformer + cursor record
 * builder. Sub-field row mappers (mechanism / warning / indication / trial
 * / target_association) live in lib/open-targets-aggregator.js so each
 * file stays under the Art 5.1 250-line cap AND so per-field mapping is
 * independently unit-testable.
 *
 * Architecture note (see [[researcher_needs_anchor]] decision 2026-05-24):
 * PR-OT-3c expanded scope to 6 tables joined via DuckDB COPY ... TO JSON
 * in the workflow. The Node side here consumes one JSONL row per OT drug
 * with pre-aggregated nested arrays (mechanisms[], warnings[],
 * indications[].trials[], target_associations[]). Researcher use cases
 * across compound queries, NegEvidence queries, and side-effect-profile
 * queries all require the trial nesting to be present in the artifact -
 * deferring clinical_report was rejected as a long-tail-relation cut per
 * [[no_shortcut_in_science]] banned pattern 5.
 */

import {
    mapMechanism, mapWarning, mapIndication, mapTargetAssociation,
} from './open-targets-aggregator.js';

const ENTITY_ID_PREFIX = 'sciweon::ot-drug::';

/**
 * Transform one pre-aggregated OT JOIN row into a Sciweon OT-bulk record.
 * Row input shape (snake_case keys produced by the DuckDB JOIN SQL's
 * STRUCT literal aliases - see workflow factory-open-targets-bulk.yml
 * ingest job):
 *   id VARCHAR (ChEMBL ID, REQUIRED)
 *   canonical_smiles / inchi_key / drug_type / name / parent_id / VARCHAR
 *   trade_names / synonyms / child_chembl_ids VARCHAR[]
 *   cross_references STRUCT(source VARCHAR, ids VARCHAR[])[]
 *   maximum_clinical_stage / description VARCHAR
 *   mechanisms STRUCT(action_type, mechanism, target_name, target_type,
 *     targets[], references[])[]  -- from drug_mechanism_of_action
 *   warnings STRUCT(warning_type, toxicity_class, country, description,
 *     efo_term, efo_id, efo_id_for_warning_class, references[])[]
 *     -- from drug_warning
 *   indications STRUCT(disease_id, max_clinical_stage,
 *     trials STRUCT(report_id, trial_phase, trial_overall_status, year,
 *     trial_official_title, side_effects[], trial_why_stopped, ...)[])[]
 *     -- from clinical_indication x clinical_report 2-hop
 *   target_associations STRUCT(target_id)[]  -- from clinical_target
 *
 * Throws on missing/non-string id (entity-ID deterministic-construction
 * guarantee per DATA_ARCH section 3.0).
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
            drug_type: row.drug_type ?? null,
            canonical_smiles: row.canonical_smiles ?? null,
            inchi_key: row.inchi_key ?? null,
            parent_chembl_id: row.parent_id ?? null,
            trade_names: Array.isArray(row.trade_names) ? row.trade_names : [],
            synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
            child_chembl_ids: Array.isArray(row.child_chembl_ids) ? row.child_chembl_ids : [],
            max_clinical_stage: row.maximum_clinical_stage ?? null,
            description: row.description ?? null,
            mechanisms: mapList(row.mechanisms, mapMechanism),
            warnings: mapList(row.warnings, mapWarning),
            indications: mapList(row.indications, mapIndication),
        },
        target_associations: mapList(row.target_associations, mapTargetAssociation),
        cross_references: normalizeCrossReferences(row.cross_references),
        license_metadata: {
            upstream_source: 'open_targets',
            upstream_license: 'cc0-1.0',
            upstream_release: release,
            ingestion_date: ingestionDate,
        },
    };
}

/**
 * Apply a per-element mapper to an array input and drop null results.
 * Null-tolerant input: missing array or non-array yields empty array.
 */
function mapList(input, mapper) {
    if (!Array.isArray(input)) return [];
    return input.map(mapper).filter(x => x !== null);
}

/**
 * Normalize OT crossReferences STRUCT array to a clean source/ids list.
 * Same shape as PR-OT-3 baseline; the SQL JOIN preserves OT's structure
 * verbatim because PubChem/DrugBank/RxNorm xrefs feed PR-OT-4 stage-3
 * merge via crossReferences PubChem xref (preferred over UniChem bridge).
 */
function normalizeCrossReferences(refs) {
    if (!Array.isArray(refs)) return [];
    return refs
        .filter(r => r && typeof r.source === 'string' && Array.isArray(r.ids))
        .map(r => ({
            source: r.source,
            ids: r.ids.filter(id => typeof id === 'string' && id.length > 0),
        }))
        .filter(r => r.ids.length > 0);
}

/**
 * Build the OT cursor record persisted to R2 state/open-targets-cursor.json.
 * PR-OT-3c bumps schema_version to "pr-ot-3c" and changes r2_key from
 * drug-molecule.jsonl.zst to drug-enriched.jsonl.zst (replacing PR-OT-3
 * baseline output). PR-OT-5 quarterly cron uses release_version +
 * last_success_at to decide whether to re-ingest.
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
        r2_key: `processed/bulk/open-targets/${release}/drug-enriched.jsonl.zst`,
        schema_version: 'pr-ot-3c',
    };
}
