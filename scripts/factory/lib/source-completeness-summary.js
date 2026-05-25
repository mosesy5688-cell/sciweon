/**
 * Source completeness summary printer -- extracted from source-completeness.js
 * entry script per Art 5.1 250-line cap (PR-CORE-deferrals 2026-05-25).
 *
 * Pure display logic. Reads RAW per-source body for percentages but uses the
 * post-deferral adjustedSources for per-source tier flags so the printed
 * '[OK]/[HARDFAIL]/[WARN]/[INFO]' label matches the aggregate exit code.
 * Telemetry surface (deferrals_applied / expired_deferrals / new_regressions)
 * shown distinctly so operators can spot real regressions vs known long-tail.
 */

import { severityTierForPct } from './source-completeness-helpers.js';

export function printSummary(rawSources, adjustedSources, telemetry, totals, belowThreshold, severityTier, runId) {
    console.log(`\n[SOURCE-COMPLETENESS] === Summary ===`);
    console.log(`  Run id:                  ${runId}`);
    console.log(`  Total compounds:         ${totals.compounds}`);
    console.log(`  Total bioactivities:     ${totals.bioactivities}`);
    console.log(`  Total drug labels:       ${totals.drugLabels}`);
    console.log(`  DailyMed-linked %:       ${totals.dailymedLinkedPct}%`);
    console.log(`  --`);
    for (const [sourceId, s] of Object.entries(rawSources)) {
        const adjustedTier = adjustedSources[sourceId]?.severity_tier;
        const tier = typeof adjustedTier === 'number'
            ? adjustedTier
            : severityTierForPct(s.gate_adjusted_pct, sourceId);
        const flag = tier === 0 ? 'OK' : tier === 1 ? 'HARDFAIL' : tier === 2 ? 'WARN' : 'INFO';
        const note = telemetry.deferrals_applied.includes(sourceId) ? ' (deferred)'
            : telemetry.expired_deferrals.includes(sourceId) ? ' (deferral EXPIRED)' : '';
        console.log(`  ${sourceId.padEnd(22)} raw=${String(s.raw_pct).padStart(6)}%  gate=${String(s.gate_adjusted_pct).padStart(6)}%  (${s.fully_enriched}/${s.gate_pass} of ${s.total}) [${flag}]${note}`);
    }
    console.log(`  --`);
    console.log(`  Deferrals applied:       ${telemetry.deferrals_applied.length === 0 ? 'none' : telemetry.deferrals_applied.join(', ')}`);
    console.log(`  Expired deferrals:       ${telemetry.expired_deferrals.length === 0 ? 'none' : telemetry.expired_deferrals.join(', ')}`);
    console.log(`  New regressions:         ${telemetry.new_regressions.length === 0 ? 'none' : telemetry.new_regressions.join(' | ')}`);
    console.log(`  Below threshold:         ${belowThreshold.length === 0 ? 'none' : belowThreshold.join(', ')}`);
    console.log(`  Aggregate tier:          ${severityTier}`);
}
