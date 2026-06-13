/**
 * RK-15 V2 — isolated real same-day A/B immutable-publish verification harness.
 *
 * Proves on REAL R2, via the REAL producer code paths, that two same-day
 * publishes A and B (TWO real workflow runs, same session_id + UTC date,
 * DIFFERENT GITHUB_RUN_ID) get distinct immutable prefixes, B never touches A,
 * candidate validation + CAS isolated-latest activation + ACTIVE confirmation
 * work, and BOTH are independently readable — ENTIRELY inside the ISOLATED
 * namespace rk15-verification/v2/{session_id}/, NEVER touching production
 * snapshots/** or snapshots/latest.json (production latest is GET-only for the
 * before/after invariance check; every write is guarded into the namespace).
 *
 * Usage (workflow_dispatch only): node rk15-v2-publish.js --phase=A|B --session=<id>
 *   phase A: build fixture -> publish all classes create-only -> seal -> validate
 *            -> CAS isolated latest -> ACTIVE -> read back. Writes rk15-v2-evidence-A.json.
 *   phase B: read A state from R2 -> publish B -> prove A-unchanged + B-independent
 *            + CAS A->B + both-readable + collision-gate + stale-CAS-rejected.
 *            Writes rk15-v2-evidence-B.json (incl. A/B cross-comparison).
 *
 * The producer paths REUSED (not re-implemented): publishCompoundShards +
 * shard-writer (NXVF), publishNegShards, putCreateOnly, deriveSnapshotId /
 * objectPrefixFor / the v2 key layout, canonicalManifestHash (via
 * buildAndSealCandidate), validateCandidate, swapV2Latest + postSwapActiveProbe
 * (with the injected ISOLATED latestKey), and the deployed reader's
 * parseSnapshotContext for the read-back.
 */

import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

import { makeR2Client } from '../factory/lib/r2-stage-bridge.js';
import { instrumentClient, classifyError } from './rk15-v2-lib.js';
import { buildFixture } from './rk15-v2-fixture.js';
import { isolatedIdentity } from './rk15-v2-publish-fixture.js';
import { runPhaseA, runPhaseB, readAState } from './rk15-v2-phases.js';

export function parseArgs(argv) {
    const out = { phase: null, session: null };
    for (const a of argv) {
        const m = /^--(phase|session)=(.+)$/.exec(a);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

function evidenceFile(phase) { return `rk15-v2-evidence-${phase}.json`; }

/** Run one phase against a (real or mock) client. Returns the evidence report. */
export async function runPhase({ client, bucket, phase, sessionId, date, runId, runAttempt, commitSha }) {
    const fixture = await buildFixture();
    const identity = isolatedIdentity(sessionId, date, runId, runAttempt, commitSha);
    const inst = instrumentClient(client);
    if (phase === 'A') {
        return runPhaseA({ client: inst, bucket, sessionId, identity, fixture });
    }
    if (phase === 'B') {
        const aEvidence = await readAState({ client: inst, bucket, sessionId });
        return runPhaseB({ client: inst, bucket, sessionId, identity, fixture, aEvidence });
    }
    throw new Error(`unknown phase ${JSON.stringify(phase)} (expected A or B)`);
}

async function main() {
    const { phase, session } = parseArgs(process.argv.slice(2));
    if (!phase || !['A', 'B'].includes(phase)) throw new Error('--phase=A|B is required');
    if (!session) throw new Error('--session=<session_id> is required');

    const bucket = process.env.R2_BUCKET;
    const client = makeR2Client(); // throws loud if env not configured
    const date = process.env.RK15_V2_DATE || new Date().toISOString().slice(0, 10);
    const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
    const commitSha = process.env.GITHUB_SHA || null;

    const report = await runPhase({ client, bucket, phase, sessionId: session, date, runId, runAttempt, commitSha });
    report.session_id = session;
    report.run_id = runId;
    report.run_attempt = runAttempt;
    report.commit_sha = commitSha;

    const json = JSON.stringify(report, null, 2);
    writeFileSync(evidenceFile(phase), json);
    console.log(json);
    const passed = phase === 'A' ? report.a_pass : report.b_pass;
    console.log(`\n=== RK-15 V2 phase ${phase} === ${passed ? 'PASS' : 'FAIL'} (session ${session})`);
    process.exit(passed ? 0 : 1);
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
    main().catch(err => {
        console.error('[rk15-v2-publish] FATAL:', err);
        try {
            const phase = parseArgs(process.argv.slice(2)).phase || 'X';
            writeFileSync(evidenceFile(phase), JSON.stringify({
                harness: 'rk15-v2-publish', fatal: true, error: classifyError(err),
                a_pass: false, b_pass: false,
            }, null, 2));
        } catch { /* best-effort */ }
        process.exit(1);
    });
}
