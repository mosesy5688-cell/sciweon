/**
 * Target entity schema — Sciweon V0.1 / cycle 23 PR-SID-1.4-pre.1b.
 *
 * Protein target (human protein_coding gene, biotype filter at OT ingest).
 * Identity anchor per V1.0 §26: UniProt accession primary, Ensembl gene
 * ID fallback. Phase 1.4 SID stamping uses both per multi-canonicalization-
 * version pattern from Phase 1.3 (paper DOI/OpenAlex precedent).
 *
 * Source priority:
 *   - Open Targets (primary): full metadata including approved_symbol,
 *     approved_name, target_class, dbXrefs, synonyms, function descriptions,
 *     subcellular locations, genomic location
 *   - ChEMBL bioactivity.target (secondary): UniProt-only targets not in OT;
 *     skeleton record with just uniprot_accession + organism context
 *
 * Defect-8 truncation roll-up: isoform suffix (-N) stripped at OT ingest
 * + bioactivity merge. Isoforms fold onto canonical protein continuity
 * entity per V1.0 §22 Permanence.
 *
 * Defect-9 hard filter: biotype='protein_coding' at OT SQL Layer 1 +
 * transformer Layer 2. Non-protein targets out of scope (V2.0+).
 */

export const TARGET_SCHEMA = {
    id: { type: 'string', required: true, pattern: /^sciweon::target::/ },
    uniprot_accession: { type: 'string', required: false, pattern: /^[A-NR-Z][0-9][A-Z0-9]{3}[0-9]$/ },
    ensembl_gene_id: { type: 'string', required: false, pattern: /^ENSG\d{11}$/ },
    approved_symbol: { type: 'string', required: false, maxLength: 100 },
    approved_name: { type: 'string', required: false, maxLength: 500 },
    biotype: { type: 'string', required: false, enum: ['protein_coding'] },
    uniprot_trembl_ids: { type: 'array', required: false, maxItems: 50 },
    target_class: {
        type: 'array', required: false, maxItems: 50,
        items: {
            id: { type: 'integer', required: false },
            label: { type: 'string', required: true, maxLength: 200 },
            level: { type: 'string', required: false, maxLength: 20 },
        },
    },
    db_xrefs: {
        type: 'array', required: false, maxItems: 200,
        items: {
            id: { type: 'string', required: true, maxLength: 200 },
            source: { type: 'string', required: true, maxLength: 100 },
        },
    },
    synonyms: { type: 'array', required: false, maxItems: 200, itemType: 'string', itemMaxLength: 200 },
    symbol_synonyms: { type: 'array', required: false, maxItems: 100, itemType: 'string', itemMaxLength: 100 },
    function_descriptions: { type: 'array', required: false, maxItems: 20, itemType: 'string', itemMaxLength: 5000 },
    subcellular_locations: { type: 'array', required: false, maxItems: 50, itemType: 'string', itemMaxLength: 200 },
    genomic_location: {
        type: 'object', required: false,
        shape: {
            chromosome: { type: 'string', required: false },
            start: { type: 'integer', required: false },
            end: { type: 'integer', required: false },
            strand: { type: 'integer', required: false },
        },
    },
    organism: {
        type: 'object', required: false,
        shape: {
            taxon_id: { type: 'integer', required: false },
            scientific_name: { type: 'string', required: false, maxLength: 200 },
        },
    },
    provenance: {
        type: 'object', required: true,
        shape: {
            sources: {
                type: 'array', required: true, minItems: 1, maxItems: 10,
                items: {
                    source: { type: 'string', required: true, enum: ['open_targets', 'chembl_bioactivity'] },
                    source_id: { type: 'string', required: false, maxLength: 200 },
                    timestamp: { type: 'string', required: false, format: 'iso8601' },
                },
            },
            last_updated: { type: 'string', required: true, format: 'iso8601' },
        },
    },
};

export const TARGET_ID_PREFIX = 'sciweon::target::';
