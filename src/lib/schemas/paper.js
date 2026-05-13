/**
 * Paper entity schema — Sciweon V0.1
 *
 * Academic paper from OpenAlex / Semantic Scholar.
 * Linked to Compounds via MeSH terms, abstract NLP, and DOI cross-references.
 *
 * CRITICAL for Negative Evidence DB (V0.4):
 *   is_retracted=true + retraction_doi → V0.4 fetches original retraction notice
 *   full text and classifies reason with Sciweon's own 6-category NLP (not RW's
 *   predefined categories — those are secondary processed data, see [[feedback_no_secondary_processed_data]]).
 *
 * See: brain/SCIWEON_DATA_ARCHITECTURE.md §3.4
 */

export const PAPER_SCHEMA = {
    // ─── Identity ───
    id: { type: 'string', required: true, pattern: /^sciweon::paper::/ },
    doi: { type: 'string', required: false, pattern: /^10\.\d{4,}\/\S+$/ },
    openalex_id: { type: 'string', required: false, pattern: /^W\d+$/ },
    s2_paper_id: { type: 'string', required: false },
    pmid: { type: 'string', required: false, pattern: /^\d+$/ },

    // ─── Content ───
    title: { type: 'string', required: true, maxLength: 2000 },
    abstract: { type: 'string', required: false, maxLength: 20000 },
    publication_date: { type: 'string', required: false, format: 'iso8601_date' },
    publication_year: { type: 'integer', required: false, min: 1800, max: 2100 },

    // ─── Authors (PRIMARY ONLY — V0.1 contract) ───
    // name: raw_author_name from OpenAlex (paper's original byline string).
    //   OpenAlex's canonicalized `author.display_name` (Author-entity dedup
    //   product, secondary) is intentionally NOT consumed. Fallback only
    //   when raw is missing.
    // raw_affiliations: raw_affiliation_strings array (the paper's original
    //   affiliation block text per author). OpenAlex's institution.display_name
    //   (ROR-mapped, entity-resolved, secondary) is intentionally NOT consumed.
    //   V0.4 may add `resolved_institutions` as a separate Sciweon-computed
    //   field with explicit provenance.
    authors: {
        type: 'array', required: false, maxItems: 1000,
        itemShape: {
            name: { type: 'string', required: true, maxLength: 500 },
            raw_affiliations: { type: 'array', required: false, itemType: 'string', maxItems: 20 },
        },
    },

    // ─── Impact ───
    citation_count: { type: 'integer', required: false, min: 0 },
    is_open_access: { type: 'boolean', required: false },

    // ─── Quality Flags (CRITICAL for Negative Evidence) ───
    // V0.1 contract: PRIMARY FACTS ONLY from Retraction Watch (publisher-sourced).
    // Reason categorization is V0.4 work: use retraction_doi to fetch original
    // retraction notice full text and classify with Sciweon's own 6-category NLP.
    is_retracted: { type: 'boolean', required: true },
    retraction_doi: { type: 'string', required: false, pattern: /^10\.\d{4,}\/\S+$/ },
    retraction_date: { type: 'string', required: false, format: 'iso8601_date' },
    retraction_nature: {
        type: 'string', required: false,
        enum: ['Retraction', 'Correction', 'Expression of concern', 'Reinstatement', 'Withdrawal', null],
    },
    retraction_source: { type: 'string', required: false, enum: ['crossref_retraction_watch', 'openalex', null] },

    // ─── Topical Classification ───
    // V0.1 contract: only NIH MEDLINE MeSH terms (primary, human-curated).
    // OpenAlex concepts / fields_of_study removed — secondary ML output, ~50-70% accuracy.
    // V0.4: Sciweon's own topic classifier over abstract + MeSH primary signal.
    mesh_terms: { type: 'array', required: false, itemType: 'string', maxItems: 100 },

    // ─── Linkage to Compounds (V0.1: hint via mentions; V0.2+: NLP-based) ───
    mentioned_compounds: {
        type: 'array', required: false, maxItems: 50,
        itemShape: {
            compound_id: { type: 'string', required: true },
            mention_confidence: { type: 'number', required: false, min: 0, max: 100 },
            extraction_method: {
                type: 'string', required: false,
                enum: ['mesh', 'concept_match', 'abstract_nlp', 'title_match', 'manual', 'trial_reference'],
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
