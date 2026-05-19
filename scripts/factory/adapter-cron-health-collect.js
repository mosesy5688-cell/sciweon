/**
 * V0.5.8 Wave I-6 — collect factory-cron adapter outcomes -> report.json.
 *
 * Calls `gh run view <RUN_ID> --json jobs` for the current GHA run,
 * transforms the matrix outcomes via lib/adapter-cron-status, writes
 * ./output/adapter-cron-report.json for canary-issue-manage.js (with env
 * overrides CANARY_REPORT_PATH / CANARY_STATE_LOCAL / CANARY_ISSUE_LABEL)
 * to apply the same threshold + Issue logic as I-5.
 *
 * Required env:
 *   GH_TOKEN — gh CLI auth (workflow provides via github.token)
 *   RUN_ID   — GHA run id (set by workflow to ${{ github.run_id }})
 */

import fs from 'fs/promises';
import { execSync } from 'child_process';
import { transformGhaJobsToReport } from './lib/adapter-cron-status.js';

const OUTPUT_PATH = './output/adapter-cron-report.json';

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
    const report = transformGhaJobsToReport(jobs, runId);

    await fs.mkdir('./output', { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2));

    console.log(`[CRON-HEALTH] ${report.passed}/${report.adapter_count} passed; report written to ${OUTPUT_PATH}`);
    for (const a of report.adapters) {
        const status = a.passed ? 'PASS' : 'FAIL';
        const detail = a.error ? ` · ${a.error}` : '';
        console.log(`  ${status.padEnd(4)}  ${a.source.padEnd(20)} ${a.duration_ms}ms${detail}`);
    }
}

main().catch(err => {
    console.error('[CRON-HEALTH] Fatal:', err);
    process.exit(1);
});
