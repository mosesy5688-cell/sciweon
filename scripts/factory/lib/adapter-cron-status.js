/**
 * V0.5.8 Wave I-6 — transform GHA matrix job outcomes -> canary-shaped report.
 *
 * Reads the parsed output of `gh run view <runId> --json jobs`, picks out the
 * Adapter [<source>] matrix jobs, normalizes each into the same
 * {source, passed, error?, duration_ms} shape that canary-issue-manage.js
 * consumes. Lets I-6 reuse I-5's decision + Issue management code via env-var
 * override of report path / state path / Issue label.
 *
 * Pure function. Integration via gh CLI is in adapter-cron-health-collect.js.
 */

const ADAPTER_NAME_RE = /^Adapter \[([^\]]+)\]$/;

export function transformGhaJobsToReport(jobs, runId, generatedAt) {
    const at = generatedAt ?? new Date().toISOString();
    const adapters = [];
    for (const job of jobs ?? []) {
        const m = ADAPTER_NAME_RE.exec(job?.name ?? '');
        if (!m) continue;
        const source = m[1];
        const conclusion = job.conclusion ?? null;
        const passed = conclusion === 'success';
        const startedAt = job.startedAt ? Date.parse(job.startedAt) : 0;
        const completedAt = job.completedAt ? Date.parse(job.completedAt) : 0;
        const duration_ms = (Number.isFinite(startedAt) && Number.isFinite(completedAt) && startedAt > 0 && completedAt >= startedAt)
            ? completedAt - startedAt
            : 0;
        const record = { source, passed, duration_ms };
        if (!passed) {
            record.error = `GHA matrix job conclusion=${conclusion ?? 'unknown'}`;
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
