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
        note: 'Re-calibrated 2026-05-26 post PR-CORE-MERGE-LEAK forensic. The 32286 (37.99%) plateau is NOT data leak (deep-merge V1 verified; invariant gate green delta=0) -- it is the UniChem natural ceiling for the deterministic per-cycle baseline slice CID:105001..110000. UNII is exclusively from UniChem (UNII-only count in aggregated = 0 confirmed); UniChem hit rate for this slice is ~17.5%, all eligible records already enriched. Floor at 37.0% surfaces 1pp drift as broken-floor, lets 37.99% pass tier 0. Phase 1.8 epic: expand F1 baseline ingest scope + add secondary UNII source (FDA SRS / RxNorm bulk) to break the natural ceiling.',
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
