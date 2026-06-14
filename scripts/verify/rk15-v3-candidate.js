/**
 * RK-15 V3-A — PRODUCTION candidate build (NO production-latest swap).
 *
 * Builds an IMMUTABLE candidate in the PRODUCTION namespace
 * (snapshots/<UTC-date>/<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>/) from the FIXED
 * Run #1 aggregated source (processed/aggregated/27413864028/), WITHOUT touching
 * production snapshots/latest.json. Max candidate state: VALIDATED / ACTIVATABLE
 * / NOT ACTIVE. A SEPARATE later run (V3-B) activates ONLY this exact candidate.
 *
 * Guarantees enforced here:
 *   - the source is bound DIRECTLY to Run #1 (NOT processed/aggregated/latest.json
 *     / the current date / the latest run);
 *   - all 22 AGGREGATED_FILES are present + non-empty + attested (pre/post HEAD
 *     unchanged + sha256 + line-count) — the source is READ-ONLY (GET/HEAD);
 *   - EVERY PutObject is guarded to the candidate prefix (a production-latest
 *     write is structurally impossible);
 *   - the candidate is built/sealed/validated, then probed via the PURE reader
 *     parseSnapshotContext on an ISOLATED _candidate_latest.json (production
 *     latest is GET-only for the before/after invariance check).
 *
 * Usage (workflow_dispatch only):
 *   node rk15-v3-candidate.js [--source-run-id=27413864028] [--date=YYYY-MM-DD] [--cid=2244]
 */

import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

import { makeR2Client } from '../factory/lib/r2-stage-bridge.js';
import {
    FIXED_SOURCE_RUN_ID, FIXED_SOURCE_PREFIX, PROD_LATEST_KEY,
    instrumentCandidateClient, getObjectOrNull, classifyError, summarizePutConditionals,
} from './rk15-v3-lib.js';
import {
    evalProdLatestInvariance, evalAllWritesUnderCandidate, evalNoProdLatestWrite,
    evalNoUnconditionalPut, buildDescriptor,
} from './rk15-v3-eval.js';
import { candidateIdentity, attestSource, buildCandidate, candidateProbe, candidateLatestKey } from './rk15-v3-candidate-publish.js';

const EVIDENCE_FILE = 'rk15-v3a-evidence.json';

export function parseArgs(argv) {
    const out = { sourceRunId: FIXED_SOURCE_RUN_ID, date: null, cid: 2244 };
    for (const a of argv) {
        let m;
        if ((m = /^--source-run-id=(.+)$/.exec(a))) out.sourceRunId = m[1];
        else if ((m = /^--date=(.+)$/.exec(a))) out.date = m[1];
        else if ((m = /^--cid=(\d+)$/.exec(a))) out.cid = Number(m[1]);
    }
    return out;
}

/**
 * Run V3-A against a (real or mock) client. The instrumented client guards every
 * write to the candidate prefix. Returns the V3-A evidence pack.
 */
export async function runV3A({ client, bucket, sourceRunId, date, runId, runAttempt, commitSha, targetCid }) {
    // Hard-bind the source to Run #1 — refuse a different source id (no pointer dep).
    if (sourceRunId !== FIXED_SOURCE_RUN_ID) {
        throw new Error(`[V3A] source_run_id must be the fixed Run #1 (${FIXED_SOURCE_RUN_ID}); got ${JSON.stringify(sourceRunId)} — V3-A is bound DIRECTLY to Run #1, never a pointer/latest.`);
    }
    const identity = candidateIdentity(date, runId, runAttempt, commitSha);
    const inst = instrumentCandidateClient(client, identity.objectPrefix);
    const checks = {};

    // Production latest is GET-only (before/after invariance).
    const prodBefore = await getObjectOrNull(inst, bucket, PROD_LATEST_KEY);

    // (1)(2) source attestation: 22 files present+non-empty, pre/post HEAD unchanged.
    const source = await attestSource({ client: inst, bucket });
    checks.source_complete = {
        pass: source.inventory.length === 22 && source.inventory.every(f => f.size > 0),
        action: '22 Run#1 source files present + non-empty + attested', file_count: source.inventory.length,
    };

    // (4) candidate-only flow: build/seal/validate (NO production-latest swap).
    const cand = await buildCandidate({ client: inst, bucket, identity, buffers: source.buffers });

    // (5) candidate probe via the PURE reader on the ISOLATED candidate payload.
    const probe = await candidateProbe({
        client: inst, bucket, prefix: cand.objectPrefix, latestKey: cand.latestKey,
        manifestKey: cand.manifestKey, compoundManifest: cand.compoundManifest,
        negProbeKey: cand.negProbeKey, targetCid,
    });
    checks.candidate_probe = { pass: probe.pass, action: 'candidate probe (parseSnapshotContext on candidate payload)', ...probe.checks };

    // Invariants: production latest untouched + every write under the candidate prefix.
    const prodAfter = await getObjectOrNull(inst, bucket, PROD_LATEST_KEY);
    checks.prod_latest_invariant = evalProdLatestInvariance(prodBefore, prodAfter);
    checks.all_writes_under_candidate = evalAllWritesUnderCandidate(inst.sendLog, identity.objectPrefix);
    checks.no_prod_latest_write = evalNoProdLatestWrite(inst.sendLog);
    checks.no_unconditional_put = evalNoUnconditionalPut(inst.sendLog);

    const a_pass = Object.values(checks).every(c => c.pass);
    const descriptor = buildDescriptor({
        snapshotId: cand.snapshotId, objectPrefix: cand.objectPrefix, manifestKey: cand.manifestKey,
        manifestHash: cand.manifestHash, candidatePayloadHash: probe.candidatePayloadHash, v3aRunId: String(runId),
    });
    return {
        harness: 'rk15-v3-candidate', candidate_state: a_pass ? 'VALIDATED' : 'INCOMPLETE',
        source_run_id: FIXED_SOURCE_RUN_ID, source_prefix: FIXED_SOURCE_PREFIX,
        source_attestation_hash: source.attestationHash, source_inventory: source.inventory,
        snapshot_id: cand.snapshotId, object_prefix: cand.objectPrefix,
        run_id: String(runId), run_attempt: String(runAttempt), commit_sha: commitSha,
        manifest_key: cand.manifestKey, manifest_hash: cand.manifestHash, neg_probe_key: cand.negProbeKey,
        candidate_latest_key: candidateLatestKey(cand.objectPrefix),
        candidate_payload: probe.candidatePayload, candidate_payload_hash: probe.candidatePayloadHash,
        prod_latest_before: prodBefore && { etag: prodBefore.etag, sha256: prodBefore.sha256 },
        prod_latest_after: prodAfter && { etag: prodAfter.etag, sha256: prodAfter.sha256 },
        put_conditional_summary: summarizePutConditionals(inst.sendLog),
        descriptor, checks, a_pass,
    };
}

async function main() {
    const { sourceRunId, date, cid } = parseArgs(process.argv.slice(2));
    const bucket = process.env.R2_BUCKET;
    const client = makeR2Client(); // throws loud if env not configured
    const utcDate = date || new Date().toISOString().slice(0, 10);
    const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
    const commitSha = process.env.GITHUB_SHA || null;

    const report = await runV3A({ client, bucket, sourceRunId, date: utcDate, runId, runAttempt, commitSha, targetCid: cid });
    const json = JSON.stringify(report, null, 2);
    writeFileSync(EVIDENCE_FILE, json);
    console.log(json);
    console.log(`\n=== RK-15 V3-A === ${report.a_pass ? 'PASS' : 'FAIL'} (candidate ${report.snapshot_id}, state ${report.candidate_state}, NOT ACTIVE)`);
    process.exit(report.a_pass ? 0 : 1);
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
    main().catch(err => {
        console.error('[rk15-v3-candidate] FATAL:', err);
        try { writeFileSync(EVIDENCE_FILE, JSON.stringify({ harness: 'rk15-v3-candidate', fatal: true, error: classifyError(err), a_pass: false }, null, 2)); } catch { /* best-effort */ }
        process.exit(1);
    });
}
