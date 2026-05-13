/**
 * Paper entity schema — Sciweon V0.1
 *
 * Academic paper from OpenAlex / Semantic Scholar.
 * Linked to Compounds via MeSH terms, abstract NLP, and DOI cross-references.
 *
 * CRITICAL for Negative Evidence DB (V0.4):
 *   is_retracted=true + retraction_reason → Failure DB raw material
 *
 * See: brain/SCIWEON_DATA_ARCHITECTURE.md §3.4
 */

export const PAPER_SCHEMA = {
    // ─── Identity ───
    id: { type: 'string', required: true, pattern: /^sciweon::paper::/ },
    doi: { type: 'string', required: false, pattern: /^10\.\d{4,}\/\S+$/ },
    openalex_id: { type: 'string', required: false, pattern: /^W\d+$/ },
    s2_paper_id: { type: 'string', required: false },

    // ─── Content ───
    title: { type: 'string', required: true, maxLength: 2000 },
    abstract: { type: 'string', required: false, maxLength: 20000 },
    publication_date: { type: 'string', required: false, format: 'iso8601_date' },
    publication_year: { type: 'integer', required: false, min: 1800, max: 2100 },

    // ─── Authors ───
    authors: {
        type: 'array', required: false, maxItems: 1000,
        itemShape: {
            name: { type: 'string', required: true, maxLength: 500 },
            institutions: { type: 'array', required: false, itemType: 'string', maxItems: 20 },
        },
    },

    // ─── Impact ───
    citation_count: { type: 'integer', required: false, min: 0 },
    is_open_access: { type: 'boolean', required: false },

    // ─── Quality Flags (CRITICAL for Negative Evidence) ───
    is_retracted: { type: 'boolean', required: true },
    retraction_reason: { type: 'string', required: false, maxLength: 4000 },
    retraction_date: { type: 'string', required: false, format: 'iso8601_date' },

    // ─── Topical Classification ───
    mesh_terms: { type: 'array', required: false, itemType: 'string', maxItems: 100 },
    concepts: { type: 'array', required: false, itemType: 'string', maxItems: 100 },
    fields_of_study: { type: 'array', required: false, itemType: 'string', maxItems: 20 },

    // ─── Linkage to Compounds (V0.1: hint via mentions; V0.2+: NLP-based) ───
    mentioned_compounds: {
        type: 'array', required: false, maxItems: 50,
        itemShape: {
            compound_id: { type: 'string', required: true },
            mention_confidence: { type: 'number', required: false, min: 0, max: 100 },
            extraction_method: {
                type: 'string', required: false,
                enum: ['mesh', 'concept_match', 'abstract_nlp', 'title_match', 'manual'],
            },
        },
    },

    // ─── Linkage to Trials ───
    mentioned_trial_ids: { type: 'array', required: false, itemType: 'string', maxItems: 50 },

    // ─── PROVENANCE (V8 mandatory) ───
    provenance: {
        type: 'object', required: true,
        shape: {
            sources: {
                type: 'array', required: true, minItems: 1,
                itemShape: {
                    source: { type: 'string', enum: ['openalex', 's2'] },
                    source_id: { type: 'string', required: true },
                    timestamp: { type: 'string', format: 'iso8601' },
                    extraction_method: { type: 'string', required: true },
                },
            },
            last_updated: { type: 'string', format: 'iso8601' },
        },
    },
};
