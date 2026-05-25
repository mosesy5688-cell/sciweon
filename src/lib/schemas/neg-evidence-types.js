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

/**
 * PR-SID-1.7 Per-Type Multi-Canon (Plan A1) — 7 canon-versions, ONE flat
 * `entity_classes.negevidence.current_counter` bucket. Each evidence_type
 * gets isolated canonicalization_version so independent upstream cadences
 * (FDA FAERS / ChEMBL Bioassay / Retraction Watch / CT.gov) can break-change
 * independently without forcing cross-type co-migration (§22 micro-isolation).
 *
 * Cross-runtime: ESM-only (Node factory + Cloudflare Worker bundle).
 */
export const NEGEVIDENCE_NAMESPACE = 'negevidence';

export const NEG_EVIDENCE_CANON_VERSIONS = Object.freeze({
    [TYPE_TRIAL_FAILURE]: 'negevidence.trial_failure.v1.0',
    [TYPE_INACTIVE_BIOASSAY]: 'negevidence.inactive_bioassay.v1.0',
    [TYPE_DRUG_WITHDRAWAL]: 'negevidence.drug_withdrawal.v1.0',
    [TYPE_BLACK_BOX_WARNING]: 'negevidence.black_box_warning.v1.0',
    [TYPE_FAERS_ADR_SIGNAL]: 'negevidence.faers_adr_signal.v1.0',
    [TYPE_SERIOUS_AE_PER_TRIAL]: 'negevidence.serious_adverse_event_per_trial.v1.0',
    [TYPE_PAPER_RETRACTION]: 'negevidence.paper_retraction.v1.0',
});

const NEG_ID_PREFIX = 'sciweon::neg::';

/**
 * Tail-cleaning state machine (architect-locked 2026-05-25):
 *   1. Strip leading `sciweon::neg::`
 *   2. Collapse `::` → `:` (single colon separator)
 *   3. Lowercase entire string
 *   4. Reject if: empty after strip, `::` still present after collapse,
 *      or any non-ASCII char (defense against mojibake)
 *
 * Examples:
 *   `sciweon::neg::trial::NCT03952598` → `trial:nct03952598`
 *   `sciweon::neg::faers::CID:5002::toxicity_to_various_agents`
 *       → `faers:cid:5002:toxicity_to_various_agents`
 *
 * Returns the cleaned string OR null on rejection (caller treats null as
 * unstampable per [[cross_cycle_silent_data_loss]]).
 */
export function parseNegIdTail(rawId) {
    if (typeof rawId !== 'string') return null;
    if (!rawId.startsWith(NEG_ID_PREFIX)) return null;
    const stripped = rawId.slice(NEG_ID_PREFIX.length);
    if (stripped.length === 0) return null;
    const collapsed = stripped.replace(/::/g, ':').toLowerCase();
    if (collapsed.length === 0) return null;
    if (collapsed.includes('::')) return null;
    // Defense: reject non-ASCII (mojibake guard); allow [a-z0-9:_./-]
    if (!/^[\x00-\x7F]+$/.test(collapsed)) return null;
    return collapsed;
}

/**
 * Build the 3-field anchor metadata triple for a NegEvidence record. Returns
 * `null` on any parse failure (caller treats null as unstampable). Pure
 * function — no IO; safe to call from validation pipelines + worker runtime.
 */
export function buildNegAnchorPayload(record) {
    if (!record || typeof record !== 'object') return null;
    if (!isKnownEvidenceType(record.evidence_type)) return null;
    const canonicalization_version = NEG_EVIDENCE_CANON_VERSIONS[record.evidence_type];
    if (!canonicalization_version) return null;
    const anchor_payload = parseNegIdTail(record.id);
    if (anchor_payload === null) return null;
    return {
        namespace: NEGEVIDENCE_NAMESPACE,
        anchor_payload,
        canonicalization_version,
    };
}
