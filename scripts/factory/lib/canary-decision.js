/**
 * V0.5.8 Wave I-5 — source canary decision (pure).
 *
 * For each adapter, given:
 *   prev: { consecutive_failures, last_status, last_success_at?, last_error? } | null
 *   curr: { passed: boolean, error?, duration_ms, ... }
 *   threshold: integer (default 2)
 *
 * Decide one of:
 *   newly_failing  — prev healthy or first failure transition crosses threshold;
 *                    workflow opens an Issue
 *   still_failing  — already past threshold; workflow no-ops (no spam)
 *   recovered      — was past threshold, now passing; workflow closes Issue
 *   healthy        — never failing or passing again pre-threshold; no-op
 *   first_failure  — no prior state + failed; no-op (don't Issue on first ever)
 *
 * Also returns the updated state to write back. Caller persists.
 */

export const DEFAULT_THRESHOLD = 2;

export function decideCanaryAction(prev, curr, threshold = DEFAULT_THRESHOLD) {
    const nowIso = new Date().toISOString();
    const prevFails = prev?.consecutive_failures ?? 0;
    const wasIssued = prevFails >= threshold;

    if (curr.passed) {
        const next = {
            consecutive_failures: 0,
            last_status: 'pass',
            last_success_at: nowIso,
            last_failure_at: prev?.last_failure_at ?? null,
            last_error: null,
        };
        if (wasIssued) {
            return { kind: 'recovered', next, prev };
        }
        return { kind: 'healthy', next, prev };
    }

    // curr.passed === false
    const newFails = prevFails + 1;
    const next = {
        consecutive_failures: newFails,
        last_status: 'fail',
        last_success_at: prev?.last_success_at ?? null,
        last_failure_at: nowIso,
        last_error: curr.error ?? 'unknown',
    };

    if (!prev) {
        return { kind: 'first_failure', next, prev };
    }
    if (wasIssued) {
        return { kind: 'still_failing', next, prev };
    }
    if (newFails >= threshold) {
        return { kind: 'newly_failing', next, prev };
    }
    return { kind: 'first_failure', next, prev };
}
