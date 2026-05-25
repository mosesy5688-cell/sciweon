/**
 * Open Targets disease row transformer (cycle 23 PR-SID-1.6b-pre.1a).
 *
 * Consumes one JSON line per OT disease row from /tmp/disease-enriched.jsonl
 * (produced by scripts/factory/sql/open-targets-disease.sql DuckDB extract)
 * and emits the Sciweon OT-disease bulk record shape for R2 publication.
 *
 * Architecture: mirrors lib/open-targets-target-sql.js shape. Throws on
 * missing/non-string disease_id (entity-ID deterministic-construction
 * guarantee per V1.0 §22 Permanence Doctrine).
 *
 * Namespace handling: OT disease.id is mixed-namespace 'EFO_xxxxxxx' or
 * 'MONDO_xxxxxxx' (single VARCHAR field — confirmed by bulk acquisition
 * tracker §L363 schema verification). This transformer DOES NOT split the
 * namespace; namespace decomposition into efo_id / mondo_id is Sciweon-
 * layer (disease-linker.js per PR-SID-1.6b-pre.1b). The transformer
 * carries diseaseId verbatim plus all enrichment metadata.
 *
 * Synonyms STRUCT handling: OT disease.synonyms is a STRUCT containing
 * hasExactSynonym / hasRelatedSynonym / hasBroadSynonym / hasNarrowSynonym
 * sub-lists of strings. Defensive: project as-is into the output record;
 * downstream linker / stamper / API can select sub-fields as needed without
 * forcing a normalization choice at ingest time.
 */

const ENTITY_ID_PREFIX = 'sciweon::ot-disease::';

/** Filter array to strings only; null-tolerant. */
function stringList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(s => typeof s === 'string');
}

/** Defensive synonyms STRUCT normalization (preserves all 4 sub-lists if present). */
function normalizeSynonyms(syn) {
    if (!syn || typeof syn !== 'object') return null;
    return {
        has_exact_synonym: stringList(syn.hasExactSynonym),
        has_related_synonym: stringList(syn.hasRelatedSynonym),
        has_broad_synonym: stringList(syn.hasBroadSynonym),
        has_narrow_synonym: stringList(syn.hasNarrowSynonym),
    };
}

/**
 * Transform one OT disease row to Sciweon OT-disease bulk record.
 * Row shape (snake_case from open-targets-disease.sql):
 *   disease_id VARCHAR (REQUIRED — mixed namespace EFO_xxx / MONDO_xxx)
 *   name VARCHAR
 *   description VARCHAR (may be null)
 *   synonyms STRUCT(hasExactSynonym, hasRelatedSynonym, hasBroadSynonym, hasNarrowSynonym)
 *   therapeutic_areas VARCHAR[]
 *   parents VARCHAR[]
 *   ancestors VARCHAR[]
 *   db_xrefs VARCHAR[]
 *   code VARCHAR (URI form, e.g. http://www.ebi.ac.uk/efo/EFO_0000249)
 */
export function openTargetsDiseaseRowToSciweonRecord(row, release, ingestionDate) {
    if (!row || typeof row.disease_id !== 'string' || row.disease_id.length === 0) {
        throw new Error('[OT-DISEASE-INGEST] invalid row: missing or non-string disease_id');
    }
    const diseaseId = row.disease_id.trim();
    return {
        id: `${ENTITY_ID_PREFIX}${diseaseId}`,
        disease_id: diseaseId,
        name: typeof row.name === 'string' ? row.name : null,
        description: typeof row.description === 'string' ? row.description : null,
        synonyms: normalizeSynonyms(row.synonyms),
        therapeutic_areas: stringList(row.therapeutic_areas),
        parents: stringList(row.parents),
        ancestors: stringList(row.ancestors),
        db_xrefs: stringList(row.db_xrefs),
        code: typeof row.code === 'string' ? row.code : null,
        license_metadata: {
            upstream_source: 'open_targets',
            upstream_license: 'cc0-1.0',
            upstream_release: release,
            ingestion_date: ingestionDate,
        },
    };
}

/**
 * Build the disease cursor record persisted to R2
 * state/open-targets-disease-cursor.json (independent of drug/target cursors).
 */
export function buildDiseaseCursorRecord({
    release, recordCount,
    byteSizeUncompressed, byteSizeCompressed,
    ingestedAt,
}) {
    return {
        source: 'open_targets',
        entity_class_hint: 'disease',
        release_version: release,
        last_success_at: ingestedAt,
        record_count: recordCount,
        byte_size_uncompressed: byteSizeUncompressed,
        byte_size_compressed: byteSizeCompressed,
        r2_key: `processed/bulk/open-targets/${release}/disease-enriched.jsonl.zst`,
        schema_version: 'pr-sid-1.6b-pre.1a',
    };
}
