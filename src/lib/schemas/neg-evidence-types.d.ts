// Type-only companion for the JS SSoT module. Worker TS code imports the
// runtime array from the `.js` file but relies on these declarations for
// literal-tuple narrowing of `EvidenceType`.

export const TYPE_TRIAL_FAILURE: 'trial_failure';
export const TYPE_INACTIVE_BIOASSAY: 'inactive_bioassay';
export const TYPE_DRUG_WITHDRAWAL: 'drug_withdrawal';
export const TYPE_BLACK_BOX_WARNING: 'black_box_warning';
export const TYPE_FAERS_ADR_SIGNAL: 'faers_adr_signal';
export const TYPE_SERIOUS_AE_PER_TRIAL: 'serious_adverse_event_per_trial';
export const TYPE_PAPER_RETRACTION: 'paper_retraction';

export const NEG_EVIDENCE_TYPES: readonly [
    'trial_failure',
    'inactive_bioassay',
    'drug_withdrawal',
    'black_box_warning',
    'faers_adr_signal',
    'serious_adverse_event_per_trial',
    'paper_retraction',
];

export function isKnownEvidenceType(s: unknown): s is typeof NEG_EVIDENCE_TYPES[number];
