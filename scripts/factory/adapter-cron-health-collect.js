/**
 * V0.5.8 Wave I-6 — collect factory-cron adapter outcomes -> report.json.
 *
 * Calls `gh run view <RUN_ID> --json jobs` for the current GHA run,
 * transforms the matrix outcomes via lib/adapter-cron-status, writes
 * ./output/adapter-cron-report.json for canary-issue-manage.js (with env
 * overrides CANARY_REPORT_PATH / CANARY_STATE_LOCAL / CANARY_ISSUE_LABEL)
 * to apply the same threshold + Issue logic as I-5.
 *
 * Cycle 21 — also fetches per-source incremental cursors from R2 so the
 * transform can flag stalled adapters (last_success_at older than
 * STALLED_THRESHOLD_DAYS). GHA "success" without a real fetch is the
 * silent-drop class we just closed in the worker — this layer ensures
 * future regressions surface as Issues instead of staying invisible.
 *
 * Required env:
 *   GH_TOKEN — gh CLI auth (workflow provides via github.token)
 *   RUN_ID   — GHA run id (set by workflow to ${{ github.run_id }})
 * Optional:
 *   STALLED_THRESHOLD_DAYS — override (default 14)
 */

import fs from 'fs/promises';
import { execSync } from 'child_process';
import { transformGhaJobsToReport } from './lib/adapter-cron-status.js';
import { makeIncrementalR2, readIncrementalCursor } from './lib/incremental-cursors.js';

const OUTPUT_PATH = './output/adapter-cron-report.json';

async function loadCursors(sources) {
    const r2 = makeIncrementalR2();
    if (!r2) {
        console.warn('[CRON-HEALTH] R2 not configured — skipping cursor stalled-check');
        return new Map();
    }
    const cursors = new Map();
    for (const source of sources) {
        try {
            const c = await readIncrementalCursor(r2.client, r2.bucket, source);
            if (c) cursors.set(source, c);
        } catch (err) {
            console.warn(`[CRON-HEALTH] cursor read failed for ${source}: ${err.message}`);
        }
    }
    return cursors;
}

async function main() {
    const runId = process.env.RUN_ID;
    if (!runId) {
        console.error('[CRON-HEALTH] RUN_ID env var required (workflow sets to github.run_id)');
        process.exit(1);
    }
    let raw;
    try {
        raw = execSync(`gh run view ${runId} --json jobs`, { encoding: 'utf-8' });
    } catch (err) {
        console.error(`[CRON-HEALTH] gh run view ${runId} failed: ${err?.message ?? err}`);
        process.exit(1);
    }
    const { jobs } = JSON.parse(raw);

    // Pre-extract adapter source names so we only fetch cursors we need.
    const sources = (jobs ?? [])
        .map(j => /^Adapter \[([^\]]+)\]$/.exec(j?.name ?? ''))
        .filter(Boolean)
        .map(m => m[1]);
    const cursors = await loadCursors(sources);

    const thresholdDays = Number(process.env.STALLED_THRESHOLD_DAYS) || undefined;
    const report = transformGhaJobsToReport(jobs, runId, undefined, {
        cursors, stalledThresholdDays: thresholdDays,
    });

    await fs.mkdir('./output', { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2));

    console.log(`[CRON-HEALTH] ${report.passed}/${report.adapter_count} passed; report written to ${OUTPUT_PATH}`);
    for (const a of report.adapters) {
        const status = a.passed ? 'PASS' : (a.stalled ? 'STALL' : 'FAIL');
        const detail = a.error ? ` · ${a.error}` : '';
        console.log(`  ${status.padEnd(5)}  ${a.source.padEnd(20)} ${a.duration_ms}ms${detail}`);
    }
}

main().catch(err => {
    console.error('[CRON-HEALTH] Fatal:', err);
    process.exit(1);
});
