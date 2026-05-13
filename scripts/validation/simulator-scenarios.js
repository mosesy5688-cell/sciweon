/**
 * Agent Simulator V0.1 — Test Scenario Definitions
 *
 * Each scenario simulates an AI Agent question and lists the data fields
 * the Agent expects. The executor checks those fields against our data
 * graph and surfaces gaps.
 *
 * V0.1 contract for q7 retraction: primary facts only (detection + canonical
 * DOI proof + source provenance). Reason categorization is V0.4 — uses
 * retraction_doi to fetch original notice text and classify with Sciweon's
 * own NLP, not Retraction Watch's predefined categories (secondary data).
 */

export const TEST_SCENARIOS = [
    {
        id: 'agent_q1_compound_lookup',
        question: 'Find compound by common name',
        compoundName: 'aspirin',
        expects: ['structural_data', 'lipinski_violations', 'synonyms', 'molecular_weight', 'confidence_score'],
    },
    {
        id: 'agent_q2_drug_status',
        question: 'Is this compound an approved drug?',
        compoundName: 'aspirin',
        expects: ['max_phase', 'first_approval_year', 'withdrawn_status', 'atc_codes'],
    },
    {
        id: 'agent_q3_bioactivity_profile',
        question: 'What bioassays exist for this compound?',
        compoundName: 'aspirin',
        expects: ['active_count', 'inactive_count', 'target_diversity', 'ic50_values', 'units_standardized'],
    },
    {
        id: 'agent_q4_clinical_history',
        question: 'What trials have used this compound?',
        compoundName: 'aspirin',
        expects: ['trial_count', 'phase_distribution', 'completed_vs_terminated', 'conditions_covered'],
    },
    {
        id: 'agent_q5_failure_evidence',
        question: 'Has this compound failed in trials? Why?',
        compoundName: 'aspirin',
        expects: ['negative_outcomes', 'whyStopped_text', 'failure_classification'],
    },
    {
        id: 'agent_q6_literature_support',
        question: 'What papers support claims about this compound?',
        compoundName: 'aspirin',
        expects: ['paper_count', 'citation_counts', 'mesh_terms', 'recent_papers', 'open_access_flag'],
    },
    {
        id: 'agent_q7_retraction_check',
        question: 'Have any papers about this been retracted?',
        compoundName: 'aspirin',
        expects: ['retraction_detection', 'retraction_doi_proof', 'retraction_source_provenance'],
    },
    {
        id: 'agent_q8_confidence_per_claim',
        question: 'How reliable is the data for this compound?',
        compoundName: 'aspirin',
        expects: ['overall_confidence', 'per_dimension_confidence', 'source_count', 'structural_match_flag'],
    },
    {
        id: 'agent_q9_cross_link_validation',
        question: 'Can I trace papers to trials and back?',
        compoundName: 'aspirin',
        expects: ['paper_to_trial_links', 'trial_to_paper_links', 'doi_traceability'],
    },
    {
        id: 'agent_q10_provenance_audit',
        question: 'Where does each data point come from?',
        compoundName: 'aspirin',
        expects: ['source_list_per_field', 'timestamp_per_extraction', 'extraction_method_visible'],
    },
];
