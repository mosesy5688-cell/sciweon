/**
 * V0.5.8 Wave I-6 — transform GHA matrix job outcomes -> canary-shaped report.
 *
 * Reads the parsed output of `gh run view <runId> --json jobs`, picks out the
 * Adapter [<source>] matrix jobs, normalizes each into the same
 * {source, passed, error?, duration_ms} shape that canary-issue-manage.js
 * consumes. Lets I-6 reuse I-5's decision + Issue management code via env-var
 * override of report path / state path / Issue label.
 *
 * Cycle 21 — stalled-cursor detection (Pattern A2 observability layer).
 * GHA job conclusion alone is not enough: dailymed/who-atc adapters were
 * "succeeding" for days while emitting zero records (cursor poisoning kept
 * checkForUpdates returning hasUpdates=false). Silent. To prevent
 * recurrence: cross-reference the cursor's `last_success_at` against
 * STALLED_THRESHOLD_DAYS. If an adapter hasn't actually fetched anything
 * within that window — flag as failed so canary-issue-manage opens a
 * tracking Issue. [[feedback_cross_cycle_silent_data_loss]] closure.
 *
 * #246 — the flat STALLED_THRESHOLD_DAYS is cadence-UNAWARE and false-positives
 * long-cadence sources (who-atc: a 30-day source flagged stalled at 14.8d). The
 * stalled threshold is now PER-SOURCE via lib/source-cron-cadence.js
 * (threshold = max(flat, cadence + grace)). Daily sources keep the flat 14d
 * genuine-stall detection; a long-cadence source still alarms, just at its
 * cadence-correct threshold ([[no_shortcut_in_science]] / no-silent-loss).
 */

import { stalledThresholdFor } from './source-cron-cadence.js';

const ADAPTER_NAME_RE = /^Adapter \[([^\]]+)\]$/;
const DEFAULT_STALLED_THRESHOLD_DAYS = 14;

function ageDays(ts, now) {
    if (!ts) return Infinity;
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return Infinity;
    return (now - t) / 86400000;
}

export function transformGhaJobsToReport(jobs, runId, generatedAt, opts = {}) {
    const at = generatedAt ?? new Date().toISOString();
    const now = Date.parse(at) || Date.now();
    const cursors = opts.cursors ?? new Map();
    const thresholdDays = opts.stalledThresholdDays ?? DEFAULT_STALLED_THRESHOLD_DAYS;
    const adapters = [];
    for (const job of jobs ?? []) {
        const m = ADAPTER_NAME_RE.exec(job?.name ?? '');
        if (!m) continue;
        const source = m[1];
        const conclusion = job.conclusion ?? null;
        const ghaPassed = conclusion === 'success';
        const startedAt = job.startedAt ? Date.parse(job.startedAt) : 0;
        const completedAt = job.completedAt ? Date.parse(job.completedAt) : 0;
        const duration_ms = (Number.isFinite(startedAt) && Number.isFinite(completedAt) && startedAt > 0 && completedAt >= startedAt)
            ? completedAt - startedAt
            : 0;
        const record = { source, passed: ghaPassed, duration_ms };
        if (!ghaPassed) {
            record.error = `GHA matrix job conclusion=${conclusion ?? 'unknown'}`;
        }
        // Cycle 21 stalled-cursor cross-check — only when GHA passed but no
        // real progress. A failed GHA job already surfaces; don't double-tag.
        if (ghaPassed) {
            const cur = cursors.get(source);
            if (cur) {
                // #246: per-source cadence-aware threshold (long-cadence sources
                // such as who-atc are not stalled until past cadence + grace).
                const srcThreshold = stalledThresholdFor(source, thresholdDays);
                // Effective staleness: time since the last REAL fetch when known,
                // else the cursor's own age (never-succeeded). Both are gated on
                // the same cadence-aware threshold so a fresh long-cadence source
                // is not flagged before its first fetch is even due, while a
                // genuinely-quiet source still alarms past cadence + grace.
                const cursorAge = ageDays(cur.last_updated, now);
                const effectiveAge = cur.last_success_at ? ageDays(cur.last_success_at, now) : cursorAge;
                if (effectiveAge > srcThreshold) {
                    record.passed = false;
                    record.error = cur.last_success_at
                        ? `stalled: last_success_at ${effectiveAge.toFixed(1)}d ago (>${srcThreshold}d, status=${cur.status ?? 'unknown'})`
                        : `stalled: never succeeded (cursor age ${cursorAge.toFixed(1)}d, >${srcThreshold}d, status=${cur.status ?? 'unknown'})`;
                    record.stalled = true;
                }
            }
        }
        adapters.push(record);
    }
    const passed = adapters.filter(a => a.passed).length;
    return {
        generated_at: at,
        run_id: runId ?? null,
        adapter_count: adapters.length,
        passed,
        failed: adapters.length - passed,
        adapters,
    };
}
