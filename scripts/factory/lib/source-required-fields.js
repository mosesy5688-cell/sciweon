/**
 * Source required-fields SSoT - cycle 22 PR-CORE-1 (Pattern E tracker).
 *
 * Defines, per V1 source, the file in the aggregated bundle, the optional
 * upstream gate predicate, and the list of required field paths whose
 * non-null presence on a record constitutes "strict enriched" for that
 * source.
 *
 * Why a separate SSoT file:
 *   Entity schemas (compound / bioactivity / drug-label / neg-evidence)
 *   mix all sources into one document. Tier-class completeness is a
 *   per-source view that does not exist anywhere else - without this
 *   registry the tracker would scatter source-specific path strings
 *   across hundreds of lines, exactly the kind of drift aggregated-files.js
 *   was created to prevent.
 *
 * Adding a 9th source = one entry here + (optionally) one extension to
 * AGGREGATED_FILES SSoT. No changes to source-completeness.js required.
 *
 * Triple-lock anchor (per [[no-shortcut-in-science]]):
 *   - scale: every record in each file is counted (no Top-N).
 *   - quality: required_paths is the STRICT semantic - missing any one
 *     path yields fully_enriched=false; the registry encodes the contract,
 *     not impressions about it.
 *   - relational structure: denominator_gate captures upstream chained
 *     dependencies (UNII -> RxNorm/FAERS), preserving the cross-source
 *     structure rather than collapsing to a flat denominator that would
 *     conflate "upstream gate missing" with "this source failed".
 *
 * Conditional denominators (denominator_gate):
 *   Some sources can only be present when an upstream field exists.
 *   E.g. OpenFDA FAERS enrichment requires UNII to be resolved first
 *   (via UniChem). Reporting `enriched / total_records` for FAERS would
 *   mechanically cap the % at UniChem coverage. The tracker emits both
 *   `raw_pct` (full denominator) and `gate_adjusted_pct` (gate-passing
 *   denominator); PR-CORE-2 consumes the latter for prioritization.
 *
 * Required-paths encoding:
 *   - Dotted path access (`a.b.c`) traverses nested objects.
 *   - Plain path: resolved value must be non-null AND non-undefined.
 *   - `[]` suffix: array length >= 1 required.
 *   - `===<json>` suffix: strict equality to literal required.
 *   - `~~<json>` suffix: array contains literal required.
 *   The resolver lives in source-completeness-helpers.js.
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
        // PR-CORE-1c (2026-05-23): gate by drug_status block existence.
        // Without this gate the % conflated 3 categories: (a) compound
        // not in ChEMBL (chembl_id=null), (b) compound in ChEMBL but not
        // a drug (chembl_id set, drug_status=null), (c) compound is a
        // drug but drug_status fields incomplete. Only (c) is an
        // actionable enrichment gap for PR-CORE-2; (a) and (b) are not
        // ChEMBL coverage issues. Sample verification 2026-05-23 confirmed
        // most ChEMBL-matched compounds have drug_status=null (they are
        // bioactivity references, not drugs). Phase 0 finding.
        denominator_gate: 'drug_status',
        required_paths: Object.freeze([
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
        // PR-CORE-1d (2026-05-23): per-source threshold override. Probed
        // 9.46% gate-adjusted. Natural API ceiling ~10-12% for current
        // non-drug-heavy compound mix (most PubChem CIDs are chemicals
        // not in RxNorm). Will rise to ~80% only after cycle 23 RxNorm
        // bulk #34 lands (see SCIWEON_BULK_ACQUISITION_TRACKER row #34).
        // Conservative hardfail at 3% trips on real regression (RxNorm
        // API broken). Cycle 23 PR-CORE-1e bumps once bulk in place.
        severity_thresholds: Object.freeze({ hardfail: 3, warn: 5, info: 10 }),
    }),

    unichem: Object.freeze({
        // PR-FDA-SRS-3 Option E: anchors on explicit unichem_matched flag
        // (stamped by compound-id-resolver enrichOne when fetchByInchiKey
        // returns non-null). Decoupled from external_ids.unii which FDA SRS
        // now also writes -- prevents false-credit pollution. Mass bootstrap
        // of historical records: aggregated-merger.js deepMergeCompound.
        file: 'compounds-enriched.jsonl',
        denominator_gate: null,
        required_paths: Object.freeze(['external_ids.unichem_matched===true']),
        severity_thresholds: Object.freeze({ hardfail: 25, warn: 35, info: 45 }),
    }),

    fda_srs: Object.freeze({
        // PR-FDA-SRS-3 cascade closer: SECONDARY UNII source independent of
        // UniChem. 5000-slice prod measurement 2026-05-27: 893/5000 reach +
        // 25 UNII vertical-depth fills for UniChem-non-UNII records.
        file: 'compounds-enriched.jsonl',
        denominator_gate: 'inchi_key',
        required_paths: Object.freeze(['external_ids.unii', 'external_ids.sources~~"fda_srs"']),
        severity_thresholds: Object.freeze({ hardfail: 30, warn: 60, info: 90 }),
    }),

    openfda_faers: Object.freeze({
        file: 'compounds-enriched.jsonl',
        // FAERS pull is keyed by UNII (same gate as RxNorm).
        denominator_gate: 'external_ids.unii',
        required_paths: Object.freeze([
            'fda_signals.faers_top_adr_terms[]',
            'fda_signals.faers_total_top_count',
        ]),
        // PR-CORE-1d (2026-05-23): per-source threshold override. Probed
        // 2.36% gate-adjusted. FAERS only covers drugs with adverse-event
        // reports - vast majority of UNII-bearing compounds are non-drug
        // chemicals with no FAERS data. Natural ceiling ~3-5%. Conservative
        // hardfail at 1% catches real regression while allowing the
        // genuine natural ceiling. Cycle 23 PR-CORE-1e refines.
        severity_thresholds: Object.freeze({ hardfail: 1, warn: 2, info: 5 }),
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
        // (per [[no-shortcut-in-science]] quality leg - "looked up" is
        // not "confirmed"). PR-CORE-2 uses this to identify ChEMBL-only
        // activities needing PubChem confirmation.
        denominator_gate: null,
        required_paths: Object.freeze([
            'cross_source_consensus.has_pubchem_match===true',
        ]),
        // PR-CORE-1d (2026-05-23): per-source threshold override. Probed
        // 5.57%. Cross-validation rate is intrinsically small - only
        // bioactivities where ChEMBL measurement happens to have an
        // overlapping PubChem assay record. Natural ceiling ~10-20%.
        // Conservative hardfail at 2% catches real regression (PubChem
        // BioAssay API broken). Cycle 23 PR-CORE-1e refines.
        severity_thresholds: Object.freeze({ hardfail: 2, warn: 5, info: 10 }),
    }),

    open_targets: Object.freeze({
        // Cycle 23 PR-OT-2 - Open Targets Platform (10th parallel source,
        // derived_aggregation, confidence weight=8). OT writes three
        // top-level compound fields (named to match the chembl_id /
        // drug_status convention, not nested under external_ids):
        //   compound.known_drug_info       - drug-level metadata (drug_type,
        //                                    max_clinical_stage, mechanisms[],
        //                                    indications[], warnings[]) merged
        //                                    from drug_molecule + indication
        //                                    + mechanism_of_action + warning
        //                                    + known_drug tables.
        //   compound.target_associations[] - drug -> target evidence joining
        //                                    mechanism_of_action with overall
        //                                    association scores. Entry =
        //                                    {target_id, evidence_score,
        //                                    datasource_ids[]}.
        //   compound.genetic_evidence[]    - variant/GWAS evidence for the
        //                                    drug's targets (conditional on
        //                                    upstream evidence).
        // Gate=chembl_id (OT's primary key is ChEMBL molecule ID; non-ChEMBL
        // compounds cannot be OT-mapped). PR-OT-4 stage-3 merge resolves the
        // join via OT's own crossReferences PubChem xref (preferred) or
        // direct ChEMBL ID match (fallback).
        file: 'compounds-enriched.jsonl',
        denominator_gate: 'chembl_id',
        required_paths: Object.freeze([
            'known_drug_info.chembl_id',
        ]),
        // PR-OT-2 pre-ingest estimate; PR-OT-5 calibrates against the 26.03
        // ingest baseline. Of 69977 compounds ~7% have chembl_id (cycle 22
        // 4945/69977); OT covers ~22K known drugs out of ~2.4M ChEMBL
        // molecules so gate-adjusted natural ceiling ~40-50%. Conservative
        // hardfail=10 catches pipeline regression below natural floor.
        severity_thresholds: Object.freeze({ hardfail: 10, warn: 20, info: 35 }),
    }),
});

// Severity tiers - see source-completeness.js exit-code mapping.
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
