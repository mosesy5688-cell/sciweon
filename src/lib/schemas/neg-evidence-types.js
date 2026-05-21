/**
 * NegEvidence evidence_type canonical taxonomy — single source of truth.
 *
 * Previously the 7 evidence types lived in three places (worker
 * event-type-taxonomy.ts / schema neg-evidence.js / builder stats dict).
 * Any drift between them produced silently-misclassified records: a typo
 * at the producer would pass the schema enum if it happened to match the
 * stale list, while the worker filter would treat it as `unknown`. This
 * module collapses all three into one frozen array + per-type named
 * constants so emission sites cannot drift from validation.
 *
 * Cross-runtime: ESM-only (Node factory + Cloudflare Worker bundle both
 * import this `.js` directly). The accompanying `.d.ts` gives TS the
 * literal tuple type for `EvidenceType` derivation.
 */

export const TYPE_TRIAL_FAILURE = 'trial_failure';
export const TYPE_INACTIVE_BIOASSAY = 'inactive_bioassay';
export const TYPE_DRUG_WITHDRAWAL = 'drug_withdrawal';
export const TYPE_BLACK_BOX_WARNING = 'black_box_warning';
export const TYPE_FAERS_ADR_SIGNAL = 'faers_adr_signal';
export const TYPE_SERIOUS_AE_PER_TRIAL = 'serious_adverse_event_per_trial';
export const TYPE_PAPER_RETRACTION = 'paper_retraction';

export const NEG_EVIDENCE_TYPES = Object.freeze([
    TYPE_TRIAL_FAILURE,
    TYPE_INACTIVE_BIOASSAY,
    TYPE_DRUG_WITHDRAWAL,
    TYPE_BLACK_BOX_WARNING,
    TYPE_FAERS_ADR_SIGNAL,
    TYPE_SERIOUS_AE_PER_TRIAL,
    TYPE_PAPER_RETRACTION,
]);

const NEG_EVIDENCE_TYPE_SET = new Set(NEG_EVIDENCE_TYPES);

export function isKnownEvidenceType(s) {
    return typeof s === 'string' && NEG_EVIDENCE_TYPE_SET.has(s);
}
