/**
 * Source required-fields SSoT — cycle 22 PR-CORE-1 (Pattern E tracker).
 *
 * Defines, per V1 source, the file in the aggregated bundle, the optional
 * upstream gate predicate, and the list of required field paths whose
 * non-null presence on a record constitutes "strict enriched" for that
 * source.
 *
 * Why a separate SSoT file:
 *   Entity schemas (compound / bioactivity / drug-label / neg-evidence)
 *   mix all sources into one document. Tier-class completeness is a
 *   per-source view that does not exist anywhere else — without this
 *   registry the tracker would scatter source-specific path strings
 *   across hundreds of lines, exactly the kind of drift `aggregated-files.js`
 *   was created to prevent.
 *
 * Adding a 9th source = one entry here + (optionally) one ingestion file
 * extending the AGGREGATED_FILES SSoT. No changes to source-completeness.js
 * required — it iterates this registry.
 *
 * Triple-lock anchor (per [[no_shortcut_in_science]]):
 *   - 规模: every record in each file is counted (no Top-N).
 *   - 质量: required_paths is the STRICT semantic — missing any one path
 *     yields fully_enriched=false; the registry encodes the contract, not
 *     impressions about it.
 *   - 关联结构: denominator_gate captures upstream chained dependencies
 *     (UNII → RxNorm/FAERS), preserving the cross-source structure rather
 *     than collapsing to a flat denominator that would conflate
 *     "upstream gate missing" with "this source failed".
 *
 * Conditional denominators (denominator_gate):
 *   Some sources can only be present when an upstream field exists.
 *   E.g. OpenFDA FAERS enrichment requires UNII to be resolved first
 *   (via UniChem). Reporting `enriched / total_records` for FAERS would
 *   mechanically cap the % at UniChem coverage and mask the real signal:
 *   "of the records that COULD be FAERS-enriched, what fraction are?".
 *   The tracker emits both `raw_pct` (full denominator) and
 *   `gate_adjusted_pct` (gate-passing denominator); PR-CORE-2 consumes
 *   the latter for prioritization.
 *
 * Required-paths semantics:
 *   - Dotted path access (`a.b.c`) traverses nested objects.
 *   - For each path, the resolved value must be non-null AND non-undefined.
 *   - Special encoding for "array length >= 1": suffix the path with `[]`
 *     (e.g. `fda_signals.faers_top_adr_terms[]`) — requires the resolved
 *     value to be an array with length >= 1.
 *   - Special encoding for "value equals literal": suffix with `===<json>`
 *     (e.g. `cross_source_consensus.has_pubchem_match===true`).
 *   - Special encoding for "array contains literal": suffix with `~~<json>`
 *     (e.g. `external_ids.sources~~"unichem"`) — requires the resolved
 *     value to be an array that includes the literal.
 *   The resolver lives in source-completeness.js (resolveRequiredPath).
 */

export const SOURCE_REQUIRED_FIELDS = Object.freeze({
    pubchem: Object.freeze({
        file: 'compounds-enriched.jsonl',
        denominator_gate: null,
        required_paths: Object.freeze([
            'id',
            'pubchem_cid',
            'inchi_key',
            'smiles_canonical',
            'molecular_formula',
            'molecular_weight.value',
        ]),
    }),

    chembl: Object.freeze({
        file: 'compounds-enriched.jsonl',
        denominator_gate: null,
        required_paths: Object.freeze([
            'chembl_id',
            'drug_status.withdrawn',
            'drug_status.black_box_warning',
        ]),
    }),

    dailymed: Object.freeze({
        // Authoritative DrugLabel surface lives in drug-labels.jsonl.
        // Compound-side `drug_labels[]` summary is tracked separately via
        // dailymed_linked_compounds_pct (see source-completeness.js).
        file: 'drug-labels.jsonl',
        denominator_gate: null,
        required_paths: Object.freeze([
            'id',
            'setid',
            'title',
            'sections',
            'published_date',
        ]),
    }),

    rxnorm: Object.freeze({
        file: 'compounds-enriched.jsonl',
        // RxNorm resolution chains off UniChem-supplied UNII. Compounds
        // without UNII are not eligible to be RxNorm-enriched.
        denominator_gate: 'external_ids.unii',
        required_paths: Object.freeze([
            'external_ids.rxcui',
        ]),
    }),

    unichem: Object.freeze({
        file: 'compounds-enriched.jsonl',
        denominator_gate: null,
        required_paths: Object.freeze([
            'external_ids.unii',
            'external_ids.sources~~"unichem"',
        ]),
    }),

    openfda_faers: Object.freeze({
        file: 'compounds-enriched.jsonl',
        // FAERS pull is keyed by UNII (same gate as RxNorm).
        denominator_gate: 'external_ids.unii',
        required_paths: Object.freeze([
            'fda_signals.faers_top_adr_terms[]',
            'fda_signals.faers_total_top_count',
        ]),
    }),

    chembl_bioactivity: Object.freeze({
        file: 'bioactivities.jsonl',
        denominator_gate: null,
        required_paths: Object.freeze([
            'id',
            'compound_id',
            'target_id',
            'activity_type',
            'value',
            'unit',
        ]),
    }),

    pubchem_bioassay: Object.freeze({
        file: 'bioactivities.jsonl',
        // PubChem BioAssay appears only as a cross-validation stamp on
        // ChEMBL-sourced bioactivities. Strict-enriched = an independent
        // PubChem assay confirmed the measurement; has_pubchem_match=false
        // means "checked but unmatched" and is NOT counted as enriched
        // (per [[no_shortcut_in_science]] quality leg — "looked up" ≠
        // "confirmed"). PR-CORE-2 uses this to identify ChEMBL-only
        // activities needing PubChem confirmation.
        denominator_gate: null,
        required_paths: Object.freeze([
            'cross_source_consensus.has_pubchem_match===true',
        ]),
    }),
});

// Severity tiers — see source-completeness.js exit-code mapping.
export const SEVERITY_THRESHOLDS = Object.freeze({
    hardfail: 50,   // below = exit 1
    warn: 80,       // below = exit 2
    info: 95,       // below = exit 3
});

// Convenience: file groups for streaming pass.
export function filesNeeded() {
    const files = new Set();
    for (const entry of Object.values(SOURCE_REQUIRED_FIELDS)) {
        files.add(entry.file);
    }
    return [...files].sort();
}
