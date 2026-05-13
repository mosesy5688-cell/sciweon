/**
 * Bioactivity Scorer V0.1 — Sciweon-computed is_active + confidence.
 *
 * Per feedback_no_secondary_processed_data: ChEMBL's `activity_comment` text
 * is a curator's secondary annotation, and ChEMBL native `confidence_score`
 * (0-9) is a curator's secondary assessment of target-assay reliability.
 * Neither should leak into Sciweon's data graph as fact.
 *
 * This module derives both fields from PRIMARY measurement data:
 *   - is_active: from value + activity_type + unit thresholds
 *   - sciweon_confidence (0-100): from unit standardness + activity_type
 *     well-known-ness + assay_type completeness + value plausibility range
 *
 * V0.4 path:
 *   - Replace IC50<1uM rule with target-specific cutoffs (some targets have
 *     very different active ranges, e.g. kinases vs ion channels)
 *   - Add cross-assay consistency boost (same compound/target measured by
 *     N independent groups within agreement = confidence +)
 */

// Concentration units → nM normalization factor.
const UNIT_TO_NM = {
    nM: 1,
    uM: 1000,
    mM: 1_000_000,
    M: 1_000_000_000,
};

const CONCENTRATION_TYPES = new Set(['IC50', 'Ki', 'EC50', 'Kd', 'AC50', 'IC90', 'GI50']);
const INHIBITION_TYPES = new Set(['inhibition']);
const STANDARD_TYPES = new Set([...CONCENTRATION_TYPES, ...INHIBITION_TYPES]);
const STANDARD_UNITS = new Set(['nM', 'uM', 'mM', 'M', 'percent']);

// Activity thresholds (V0.1 baseline — V0.4 may refine by target class).
const ACTIVE_NM_THRESHOLD = 1_000;      // < 1 uM = active
const INACTIVE_NM_THRESHOLD = 10_000;   // > 10 uM = inactive
const ACTIVE_INHIBITION_PCT = 50;       // > 50% inhibition = active
const INACTIVE_INHIBITION_PCT = 20;     // < 20% inhibition = inactive

/**
 * Derive is_active from primary measurement.
 * Returns:
 *   true  — clearly active by threshold
 *   false — clearly inactive
 *   null  — inconclusive / cannot determine (caller stores null)
 *
 * Returns also the method used (for provenance / audit).
 */
export function deriveIsActive({ value, unit, activity_type }) {
    if (value == null || !Number.isFinite(value) || value < 0) {
        return { is_active: null, method: 'no_numeric_value' };
    }

    if (CONCENTRATION_TYPES.has(activity_type) && UNIT_TO_NM[unit] != null) {
        const valueNm = value * UNIT_TO_NM[unit];
        if (valueNm < ACTIVE_NM_THRESHOLD) return { is_active: true, method: 'concentration_threshold_v1' };
        if (valueNm > INACTIVE_NM_THRESHOLD) return { is_active: false, method: 'concentration_threshold_v1' };
        return { is_active: null, method: 'concentration_inconclusive_v1' };
    }

    if (INHIBITION_TYPES.has(activity_type) && unit === 'percent') {
        if (value > ACTIVE_INHIBITION_PCT) return { is_active: true, method: 'inhibition_threshold_v1' };
        if (value < INACTIVE_INHIBITION_PCT) return { is_active: false, method: 'inhibition_threshold_v1' };
        return { is_active: null, method: 'inhibition_inconclusive_v1' };
    }

    return { is_active: null, method: 'non_standard_metric' };
}

/**
 * Compute Sciweon's own bioactivity confidence (0-100).
 *
 * Single-source (ChEMBL) baseline = 50. Increments for primary-data quality
 * signals. We do NOT consume ChEMBL's native `confidence_score`.
 */
export function scoreBioactivityConfidence({ value, unit, activity_type, assay_type }) {
    let score = 50;
    if (STANDARD_UNITS.has(unit)) score += 20;
    if (STANDARD_TYPES.has(activity_type)) score += 10;
    if (assay_type && assay_type !== 'other') score += 10;
    // Value within plausible pharmacological range
    if (UNIT_TO_NM[unit] != null) {
        const valueNm = value * UNIT_TO_NM[unit];
        // Plausible: 1 pM (0.001 nM) to 100 mM (1e8 nM)
        if (valueNm >= 0.001 && valueNm <= 1e8) score += 10;
    } else if (unit === 'percent' && value >= 0 && value <= 100) {
        score += 10;
    }
    return Math.max(0, Math.min(100, score));
}
