/**
 * Source Cron Cadence -- per-source REFRESH cadence for the cron-health
 * stalled-cursor check (adapter-cron-status.js).
 *
 * The cron-health monitor flags an adapter "stalled" when its incremental
 * cursor's last_success_at is older than a FLAT STALLED_THRESHOLD_DAYS (=14).
 * That flat window is only correct for sources that advance their cursor on a
 * (sub-)daily rhythm. A long-cadence source that fetches only every N days BY
 * DESIGN (its checkForUpdates gates hasUpdates on daysSince(cursor) >= N) has a
 * last_success_at that is normally up to N days old -- so the flat 14d window
 * FALSE-POSITIVES it (#246: who-atc, a 30-day source, flagged stalled at 14.8d
 * with status=no_updates).
 *
 * Fix mirrors lib/source-health-policy.js: an explicit per-source cadence map,
 * each entry JUSTIFIED, unknown sources defaulting to fail-loud. This is NOT a
 * blanket threshold bump ([[no_shortcut_in_science]]): only sources whose REAL
 * fetch cadence is >= the flat window carry an entry; every daily/frequent
 * source keeps the unchanged 14d genuine-stall detection. A genuinely-stalled
 * long-cadence source still alarms -- just at the cadence-correct threshold
 * (cadence + grace), never silently ([[cross_cycle_silent_data_loss]]).
 *
 * The cadence here is the source's REAL fetch cadence = the minimum interval at
 * which it advances last_success_at -- NOT the adapter's fallbackFullRefreshDays
 * ceiling. For who-atc / nci-thesaurus the two coincide (their checkForUpdates
 * literally gates on daysSince >= fallbackFullRefreshDays). For chembl (30) and
 * dailymed (90) the fallback is only a full-refresh CEILING: both fetch on a
 * real incremental new-data signal (chembl counts current-year approvals;
 * dailymed counts new SPLs since the cursor) and advance their cursor (sub-)
 * daily, so they are correctly LEFT at the flat 14d -- deriving from their 90/30
 * fallback would wrongly suppress a genuine stall.
 */

// Grace beyond a source's cadence before a stall alarm. A long-cadence source
// is only "stalled" once it is MEANINGFULLY past its refresh interval (a missed
// refresh window), not merely at the interval boundary -- this also stops a
// cadence-N source flapping in/out of stalled around its N-day fetch tick.
export const STALL_GRACE_DAYS = 7;

// Per-source REAL refresh cadence (days). Keyed by the matrix source name
// (== the incremental-cursor key, state/incremental-cursors/<source>.json).
// Only sources whose cadence is >= the flat stalled window need an entry; every
// other source defaults to 0 (treated as daily -> flat 14d unchanged).
export const SOURCE_CRON_CADENCE_DAYS = Object.freeze({
    // who-atc: ATC classes are published annually by WHO; the adapter gates
    // hasUpdates on daysSince(cursor) >= fallbackFullRefreshDays(=30), so its
    // last_success_at advances at most every 30 days. THE #246 false positive.
    'who-atc': 30,
    // nci-thesaurus: same gate pattern, fallbackFullRefreshDays(=14). At the
    // flat 14d window it would flap stalled exactly around its fetch tick; the
    // grace lifts the alarm to a missed-window (21d) and removes the flapping.
    'nci-thesaurus': 14,
});

/**
 * Real refresh cadence (days) for a source. Unknown / daily sources -> 0.
 * Pure; no Date / no I/O.
 * @param {string} source matrix source name (cursor key)
 * @returns {number} cadence in days (0 = daily / no long cadence)
 */
export function cadenceDaysFor(source) {
    return SOURCE_CRON_CADENCE_DAYS[source] ?? 0;
}

/**
 * Cadence-aware stalled threshold (days) for a source.
 *   threshold = max(flatStalledThresholdDays, cadence + grace)
 * A daily source (cadence 0) keeps the flat threshold; a long-cadence source is
 * only flagged once meaningfully past its refresh window. Never returns LESS
 * than the flat threshold (fail-loud floor preserved).
 * @param {string} source
 * @param {number} flatThresholdDays the flat STALLED_THRESHOLD_DAYS (default 14)
 * @returns {number} stalled threshold in days for this source
 */
export function stalledThresholdFor(source, flatThresholdDays) {
    const cadence = cadenceDaysFor(source);
    if (cadence <= 0) return flatThresholdDays;
    return Math.max(flatThresholdDays, cadence + STALL_GRACE_DAYS);
}
