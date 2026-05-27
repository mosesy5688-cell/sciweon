/**
 * Source Completeness Deferrals -- Plan B layered defense (architect-locked
 * 2026-05-25 PR-CORE-deferrals).
 *
 * Records KNOWN long-tail coverage gaps with explicit expected_coverage_pct
 * floors + due_date + responsible PR. Quiets "Factory Source Completeness"
 * persistent-red CI while preserving regression detection:
 *
 *   - Source above expected_coverage_pct -> tier 0 (PASS, expected long-tail)
 *   - Source BELOW floor -> Tier 1 HARDFAIL (broken-floor regression, blocks CI)
 *   - Deferral expired (today > due_date) -> deferral skipped, fall through
 *     to L2/L3 actual evaluation (forces re-triage; no infinite-tail debt)
 *
 * SSoT pattern mirrors source-required-fields.js -- frozen object, versioned
 * with code review. NOT R2 state (iteration 2 if ops needs runtime override).
 *
 * Calibration: floors set against gate_adjusted_pct from continuation 37 R2
 * probe of processed/aggregated/26401483110/ state. Margin chosen so 1-2pp
 * drift surfaces as broken-floor without false alarm.
 *
 * Comparison metric: gate_adjusted_pct (same denominator as severity tier
 * evaluation in source-completeness-helpers.js severityTierForPct, so the
 * deferral semantics align with the severity tier check semantics).
 */

// PR-CORE-deferrals: ISO-string lex compare after 10-char truncation
// (Fix 1 architect-locked 2026-05-25). todayIso may be 24-char Z-suffixed
// or any longer ISO; due_date is canonical 10-char YYYY-MM-DD.
export function isDeferralExpired(deferral, todayIso) {
    if (!deferral || typeof deferral.due_date !== 'string') return false;
    if (typeof todayIso !== 'string') return false;
    return todayIso.substring(0, 10) > deferral.due_date;
}

// PR-CORE-deferrals Plan B (architect-locked 2026-05-25, 4 fixes inline):
//   Fix 1: 10-char date truncation in isDeferralExpired
//   Fix 2: expired deferrals INVALIDATE (skip L1; tier untouched; force re-triage)
//   Fix 3: BELOW floor = Tier 1 HARDFAIL (no fall-through to L2/L3 masking)
//   Fix 4: deep clone input; raw historical metrics never mutated
export function applyDeferrals(perSourceStats, sourceDeferralsMap, todayIso) {
    if (!perSourceStats || typeof perSourceStats !== 'object') {
        throw new Error('[applyDeferrals] perSourceStats must be object');
    }
    if (!sourceDeferralsMap || typeof sourceDeferralsMap !== 'object') {
        throw new Error('[applyDeferrals] sourceDeferralsMap must be object');
    }
    const adjustedStats = JSON.parse(JSON.stringify(perSourceStats));
    const telemetry = { deferrals_applied: [], expired_deferrals: [], new_regressions: [] };
    for (const [source, stats] of Object.entries(adjustedStats)) {
        const deferral = sourceDeferralsMap[source];
        if (!deferral) continue;
        if (isDeferralExpired(deferral, todayIso)) {
            telemetry.expired_deferrals.push(source);
            continue;
        }
        const currentPct = stats.gate_adjusted_pct;
        if (typeof currentPct === 'number' && Number.isFinite(currentPct)
            && currentPct >= deferral.expected_coverage_pct) {
            stats.severity_tier = 0;
            telemetry.deferrals_applied.push(source);
        } else {
            stats.severity_tier = 1;
            telemetry.new_regressions.push(
                `${source}: broke_deferral_floor_below_${deferral.expected_coverage_pct}%_actual_${currentPct}%`,
            );
        }
    }
    return { adjustedStats, telemetry };
}

export const SOURCE_DEFERRALS = Object.freeze({
    rxnorm: Object.freeze({
        expected_coverage_pct: 8.0,
        due_date: '2026-06-15',
        responsible_pr: 'UTS-approval-tracker',
        note: 'Awaiting NLM UTS license approval (submitted 2026-05-24, EOB 2026-05-28 expected). Post-approval enables RxNorm bulk download. Currently ~8.97% gate-adjusted; floor at 8.0% surfaces 1pp drift as regression.',
    }),
    unichem: Object.freeze({
        expected_coverage_pct: 37.0,
        due_date: '2026-07-15',
        responsible_pr: 'PR-CORE-1e + Phase-1.8-baseline-rotation-expansion',
        note: 'Re-calibrated 2026-05-27 PR-FDA-SRS-3 semantic shift: validator now anchors on external_ids.unichem_matched=true (Option E architect V6 lock) instead of (unii AND unichem-source). Numerically equivalent post-bootstrap (aggregated-merger mass-backfill flips all historical 32,311 records to unichem_matched=true); 37.99% baseline preserved. Floor 37.0% surfaces UniChem-side regression independently of FDA SRS contribution. Phase 1.8 epic continues: expand F1 baseline ingest scope to break the natural ceiling.',
    }),
    fda_srs: Object.freeze({
        // PR-FDA-SRS-3 cascade closer 2026-05-27: grayscale launch with
        // conservative initial floor. First cycle measured 893/84975 =
        // 1.05% (only the 5K F2 baseline slice processed). Will climb as
        // multi-cycle drain covers more slices + cumulative-merge stamps
        // accumulate. PR-FDA-SRS-4 refines floor after 4+ cycles of empirical
        // trajectory.
        expected_coverage_pct: 1.0,
        due_date: '2026-07-30',
        responsible_pr: 'PR-FDA-SRS-4 + Phase-1.8-baseline-rotation-expansion',
        note: 'Grayscale floor for cycle-23 Phase 1.8 cascade closer. Validator hardfail at 30% per source-required-fields.js severity_thresholds is the LONG-TERM target. Deferral floor at 1.0% is the SHORT-TERM bootstrap reality (single-cycle coverage in 5K F2 slice = 17.86% of slice = 1.05% of 84K cumulative). Climbs +1-2pp per cycle.',
    }),
    openfda_faers: Object.freeze({
        expected_coverage_pct: 2.0,
        due_date: '2026-08-30',
        responsible_pr: 'PR-OT-5',
        note: 'FAERS long-tail per-drug coverage limited by openFDA API. Currently 3.04% gate-adjusted; floor at 2.0% surfaces catastrophic drop.',
    }),
    pubchem_bioassay: Object.freeze({
        expected_coverage_pct: 5.0,
        due_date: '2026-07-30',
        responsible_pr: 'Phase-1.5-pre.2',
        note: 'PubChem BioAssay ingest gated by bioactivity multi-canon upgrade. Currently 5.45% gate-adjusted; floor at 5.0% surfaces if PubChem source revoked.',
    }),
    open_targets: Object.freeze({
        expected_coverage_pct: 20.0,
        due_date: '2026-08-15',
        responsible_pr: 'PR-OT-5',
        note: 'OT evidence table (10M+ rows) ingest deferred post-Phase-1.6. Currently 22.6% gate-adjusted; floor at 20.0% surfaces 2.6pp drift.',
    }),
});
