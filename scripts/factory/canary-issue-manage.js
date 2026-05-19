/**
 * V0.5.8 Wave I-5 — canary Issue management script.
 *
 * Reads:
 *   output/canary-report.json          (written by source-canary.js)
 *   output/linked/canary-state.json    (downloaded from R2 by workflow, may be absent)
 *
 * Applies decideCanaryAction per adapter, then:
 *   - newly_failing  → gh issue create (label: source-canary)
 *   - recovered      → gh issue comment + close
 *   - other          → no-op
 *
 * Writes:
 *   output/linked/canary-state.json    (new state, workflow uploads back to R2)
 *
 * Requires GH_TOKEN env var for gh CLI authentication. Threshold via
 * env CANARY_THRESHOLD (default 2).
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { decideCanaryAction, DEFAULT_THRESHOLD } from './lib/canary-decision.js';

const REPORT_PATH = './output/canary-report.json';
const STATE_LOCAL = './output/linked/canary-state.json';
const ISSUE_LABEL = 'source-canary';

function ghQuiet(cmd, extraEnv = {}) {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf-8', env: { ...process.env, ...extraEnv } });
}

function ghInherit(cmd, extraEnv = {}) {
    execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}

async function main() {
    const threshold = parseInt(process.env.CANARY_THRESHOLD || String(DEFAULT_THRESHOLD), 10);
    const report = JSON.parse(await fs.readFile(REPORT_PATH, 'utf-8'));

    let state = { adapters: {} };
    try {
        state = JSON.parse(await fs.readFile(STATE_LOCAL, 'utf-8'));
    } catch { /* no prior state — first run */ }

    const actions = [];
    const newState = { adapters: {}, updated_at: new Date().toISOString() };

    for (const result of report.adapters) {
        const prev = state?.adapters?.[result.source] ?? null;
        const decision = decideCanaryAction(prev, result, threshold);
        newState.adapters[result.source] = decision.next;
        actions.push({ source: result.source, kind: decision.kind, current: result, prev });
    }

    await fs.mkdir(path.dirname(STATE_LOCAL), { recursive: true });
    await fs.writeFile(STATE_LOCAL, JSON.stringify(newState, null, 2));

    let opened = 0;
    let closed = 0;
    for (const a of actions) {
        if (a.kind === 'newly_failing') {
            const consecutive = (a.prev?.consecutive_failures ?? 0) + 1;
            const title = `[canary] ${a.source} upstream API failing (>= ${threshold} consecutive)`;
            const body = [
                `Source: \`${a.source}\``,
                `Consecutive failures: ${consecutive}`,
                `Last error: \`${a.current.error}\``,
                `Duration: ${a.current.duration_ms}ms`,
                `Last success: ${a.prev?.last_success_at ?? 'never'}`,
                ``,
                `Triggered by daily source-canary workflow via \`adapter.checkForUpdates(null)\` live probe.`,
                `Threshold: ${threshold} consecutive failures. Auto-closes on recovery.`,
            ].join('\n');
            console.log(`[ISSUE-CREATE] ${a.source}`);
            ghInherit(`gh issue create --title "${title.replace(/"/g, '\\"')}" --body "$BODY" --label "${ISSUE_LABEL}"`, { BODY: body });
            opened++;
        } else if (a.kind === 'recovered') {
            const out = ghQuiet(`gh issue list --label "${ISSUE_LABEL}" --state open --json number,title`);
            const issues = JSON.parse(out || '[]');
            const matches = issues.filter(i => i.title.includes(a.source));
            for (const i of matches) {
                console.log(`[ISSUE-CLOSE] ${a.source} (#${i.number}) recovered`);
                const comment = `Recovered. Auto-closing at ${new Date().toISOString()}.`;
                ghInherit(`gh issue comment ${i.number} --body "${comment}"`);
                ghInherit(`gh issue close ${i.number}`);
                closed++;
            }
        } else {
            console.log(`[NO-OP] ${a.source}: ${a.kind}`);
        }
    }

    console.log(`[CANARY-MANAGE] threshold=${threshold} actions=${actions.length} opened=${opened} closed=${closed}`);
}

main().catch(err => {
    console.error('[CANARY-MANAGE] Fatal:', err);
    process.exit(1);
});
