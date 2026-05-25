/**
 * Open Targets target row transformer (cycle 23 PR-SID-1.4-pre.1a).
 *
 * Consumes one JSON line per OT target row from /tmp/target-enriched.jsonl
 * (produced by scripts/factory/sql/open-targets-target.sql DuckDB extract)
 * and emits the Sciweon OT-target bulk record shape for R2 publication.
 *
 * Defect-8 truncation roll-up: sanitizeUniprot strips isoform suffix
 * (-N) per V1.0 §22 Permanence — isoforms fold onto canonical protein
 * continuity entity. The classifier in Phase 1.4 stamping (PR B) sees
 * only canonical accessions; isoform entries downstream are V1.5+ scope.
 *
 * Defect-9 hard filter: biotype filter is at SQL layer (open-targets-
 * target.sql WHERE clause); this transformer defends against any record
 * that slips through with assertBiotypeProteinCoding(row) Layer 2 check.
 *
 * Architecture: mirrors lib/open-targets-sql.js drug-side pattern. Throws
 * on missing/non-string ensembl_gene_id (entity-ID deterministic-
 * construction guarantee per V1.0 §22).
 */

const ENTITY_ID_PREFIX = 'sciweon::ot-target::';
const ISOFORM_SUFFIX = /-\d+$/;
const ALLOWED_BIOTYPE = 'protein_coding';

/** Strip UniProt isoform suffix (-N) per defect-8 truncation roll-up. */
export function sanitizeUniprot(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed) return null;
    const stripped = trimmed.replace(ISOFORM_SUFFIX, '');
    return stripped.length > 0 ? stripped : null;
}

/** Deduplicate UniProt accessions after isoform truncation; preserves order. */
export function dedupeUniprot(rawList) {
    if (!Array.isArray(rawList)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of rawList) {
        const clean = sanitizeUniprot(raw);
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

/** Defense-in-depth Layer 2 filter for biotype (Layer 1 is SQL WHERE clause). */
export function assertBiotypeProteinCoding(biotype) {
    if (biotype !== ALLOWED_BIOTYPE) {
        throw new Error(`[OT-TARGET-INGEST] biotype='${biotype}' should have been filtered at SQL layer; defect-9 Layer 1 may have regressed`);
    }
}

/** Extract id/source pairs from a STRUCT array; null-tolerant. */
function normalizeDbXrefs(refs) {
    if (!Array.isArray(refs)) return [];
    return refs
        .filter(r => r && typeof r.id === 'string' && typeof r.source === 'string')
        .map(r => ({ id: r.id, source: r.source }));
}

/** Extract id/label/level from targetClass STRUCT array. */
function normalizeTargetClass(classes) {
    if (!Array.isArray(classes)) return [];
    return classes
        .filter(c => c && typeof c.label === 'string')
        .map(c => ({
            id: typeof c.id === 'number' ? c.id : null,
            label: c.label,
            level: typeof c.level === 'string' ? c.level : null,
        }));
}

/** Normalize STRUCT(chromosome, start, end, strand) to plain object. */
function normalizeGenomicLocation(loc) {
    if (!loc || typeof loc !== 'object') return null;
    return {
        chromosome: typeof loc.chromosome === 'string' ? loc.chromosome : null,
        start: typeof loc.start === 'number' ? loc.start : null,
        end: typeof loc.end === 'number' ? loc.end : null,
        strand: typeof loc.strand === 'number' ? loc.strand : null,
    };
}

/**
 * Transform one OT target row to Sciweon OT-target bulk record.
 * Row shape (snake_case from open-targets-target.sql):
 *   ensembl_gene_id VARCHAR (REQUIRED)
 *   approved_symbol / approved_name / biotype VARCHAR
 *   uniprot_swissprot_ids / uniprot_trembl_ids VARCHAR[]
 *   db_xrefs STRUCT(id, source)[]
 *   target_class STRUCT(id BIGINT, label, level)[]
 *   synonyms / symbol_synonyms VARCHAR[]
 *   function_descriptions VARCHAR[]
 *   subcellular_locations VARCHAR[]
 *   genomic_location STRUCT(chromosome, start, end, strand)
 */
export function openTargetsTargetRowToSciweonRecord(row, release, ingestionDate) {
    if (!row || typeof row.ensembl_gene_id !== 'string' || row.ensembl_gene_id.length === 0) {
        throw new Error('[OT-TARGET-INGEST] invalid row: missing or non-string ensembl_gene_id');
    }
    assertBiotypeProteinCoding(row.biotype);
    const ensembl = row.ensembl_gene_id;
    const canonicalUniprot = dedupeUniprot(row.uniprot_swissprot_ids);
    const tremblUniprot = dedupeUniprot(row.uniprot_trembl_ids);
    return {
        id: `${ENTITY_ID_PREFIX}${ensembl}`,
        ensembl_gene_id: ensembl,
        approved_symbol: typeof row.approved_symbol === 'string' ? row.approved_symbol : null,
        approved_name: typeof row.approved_name === 'string' ? row.approved_name : null,
        biotype: row.biotype,
        uniprot_canonical_ids: canonicalUniprot,
        uniprot_trembl_ids: tremblUniprot,
        db_xrefs: normalizeDbXrefs(row.db_xrefs),
        target_class: normalizeTargetClass(row.target_class),
        synonyms: Array.isArray(row.synonyms) ? row.synonyms.filter(s => typeof s === 'string') : [],
        symbol_synonyms: Array.isArray(row.symbol_synonyms) ? row.symbol_synonyms.filter(s => typeof s === 'string') : [],
        function_descriptions: Array.isArray(row.function_descriptions) ? row.function_descriptions.filter(s => typeof s === 'string') : [],
        subcellular_locations: Array.isArray(row.subcellular_locations) ? row.subcellular_locations.filter(s => typeof s === 'string') : [],
        genomic_location: normalizeGenomicLocation(row.genomic_location),
        license_metadata: {
            upstream_source: 'open_targets',
            upstream_license: 'cc0-1.0',
            upstream_release: release,
            ingestion_date: ingestionDate,
        },
    };
}

/**
 * Build the target cursor record persisted to R2
 * state/open-targets-target-cursor.json (separate from drug-side cursor).
 */
export function buildTargetCursorRecord({
    release, recordCount,
    byteSizeUncompressed, byteSizeCompressed,
    ingestedAt,
}) {
    return {
        source: 'open_targets',
        entity_class_hint: 'target',
        release_version: release,
        last_success_at: ingestedAt,
        record_count: recordCount,
        byte_size_uncompressed: byteSizeUncompressed,
        byte_size_compressed: byteSizeCompressed,
        r2_key: `processed/bulk/open-targets/${release}/target-enriched.jsonl.zst`,
        schema_version: 'pr-sid-1.4-pre.1a',
    };
}
