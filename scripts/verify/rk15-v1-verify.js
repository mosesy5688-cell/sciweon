/**
 * RK-15 V1 — real-R2 conditional-write + failure-isolation verification harness.
 *
 * Proves on REAL R2 (not a mock) that:
 *   - create-only (IfNoneMatch:'*') is actually ENFORCED (collision -> 412),
 *   - CAS (If-Match:<etag>) is actually ENFORCED (wrong etag -> 412),
 *   - a 412 propagates and NO retry/wrapper degrades to an unconditional PUT,
 *   - the PRODUCTION snapshots/latest.json is left byte-identical (read-only).
 *
 * ALL writes go to an ISOLATED namespace `rk15-verification/<run_id>/...`.
 * Production `snapshots/latest.json` (and any `snapshots/...` object) is NEVER
 * written — only GET for the before/after invariance check. Zero destructive ops.
 *
 * Exercises the SAME production code paths the producer uses:
 *   - `putCreateOnly`     (scripts/factory/lib/snapshot-identity.js)
 *   - the CAS IfMatch path of `swapLatestPointer` (publish-shards-and-swap.js),
 *     mirrored at the isolated test key.
 *
 * Output: a structured JSON evidence report to stdout AND to `rk15-v1-evidence.json`
 * (uploaded by the workflow as an artifact). Process exits non-zero if v1_pass=false.
 *
 * Intended to run ONLY as a founder-triggered workflow_dispatch (R2 secrets live
 * in CI, not locally). It is NOT auto-triggered.
 */

import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { PutObjectCommand } from '@aws-sdk/client-s3';

import { makeR2Client } from '../factory/lib/r2-stage-bridge.js';
import { putCreateOnly } from '../factory/lib/snapshot-identity.js';
import {
    PROD_LATEST_KEY, EVIDENCE_FILE,
    sha256Hex, classifyError, instrumentClient, summarizePutConditionals,
    getObject, getObjectOrNull, printHumanSummary,
    evalCreateOnlyCollision, evalCasWrongEtag, evalNoUnconditionalPut, evalProdLatestInvariance,
} from './rk15-v1-lib.js';

export { PROD_LATEST_KEY, EVIDENCE_FILE, sha256Hex, summarizePutConditionals, printHumanSummary };

/**
 * A direct CAS PUT to a SPECIFIC test key (NOT production latest). Mirrors the
 * conditional structure swapLatestPointer uses (IfMatch CAS), targeted at an
 * arbitrary isolated key so we can drive the wrong-etag negative control.
 */
async function casPutTestKey(client, bucket, key, body, ifMatch) {
    await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body,
        ContentType: 'application/json', IfMatch: ifMatch,
    }));
}

/**
 * Run the verification harness against a (real or mock) S3 client. Returns the
 * structured evidence report. ZERO destructive ops; NEVER writes production latest.
 */
export async function runHarness(realClient, bucket, opts = {}) {
    const runId = opts.runId
        || process.env.GITHUB_RUN_ID
        || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const commitSha = opts.commitSha || process.env.GITHUB_SHA || null;
    const namespace = `rk15-verification/${runId}/`;
    const client = instrumentClient(realClient);

    const createOnlyKey = `${namespace}create-only-object`;
    const casKey = `${namespace}cas-pointer.json`;
    const bodyA = Buffer.from(`rk15-v1 create-only A ${runId}\n`, 'utf-8');
    const bodyB = Buffer.from(`rk15-v1 create-only B (collision) ${runId}\n`, 'utf-8');

    const checks = {};
    const fail = (name, extra) => { checks[name] = { pass: false, ...extra }; };
    const pass = (name, extra) => { checks[name] = { pass: true, ...extra }; };

    // ── Step 1: production latest invariance (BEFORE) — read-only ────────────
    let prodBefore = null;
    try {
        prodBefore = await getObjectOrNull(client, bucket, PROD_LATEST_KEY);
        checks.prod_latest_before = {
            pass: true, action: `GET ${PROD_LATEST_KEY} (read-only)`,
            present: prodBefore != null,
            etag: prodBefore?.etag ?? null, sha256: prodBefore?.sha256 ?? null,
        };
    } catch (err) {
        checks.prod_latest_before = {
            pass: false, action: `GET ${PROD_LATEST_KEY} (read-only)`, error: classifyError(err),
        };
    }

    // ── Step 2: create-only first PUT succeeds ───────────────────────────────
    let step2Etag = null, step2Sha = null;
    try {
        await putCreateOnly(client, bucket, createOnlyKey, bodyA, 'text/plain');
        const got = await getObject(client, bucket, createOnlyKey);
        step2Etag = got.etag; step2Sha = got.sha256;
        const expectSha = sha256Hex(bodyA);
        if (step2Sha !== expectSha) {
            fail('create_only_first_put', {
                action: `putCreateOnly ${createOnlyKey}`,
                reason: 'stored body sha != expected body sha',
                etag: step2Etag, sha256: step2Sha, expectedSha: expectSha,
            });
        } else {
            pass('create_only_first_put', {
                action: `putCreateOnly ${createOnlyKey}`, etag: step2Etag, sha256: step2Sha,
            });
        }
    } catch (err) {
        fail('create_only_first_put', {
            action: `putCreateOnly ${createOnlyKey}`,
            reason: 'first create-only PUT unexpectedly failed', error: classifyError(err),
        });
    }

    // ── Step 3: create-only collision rejected (REAL enforcement + control) ──
    // THE single most important check: a SILENTLY-IGNORED condition must NOT pass.
    {
        let secondPutErr = null, secondPutSucceeded = false;
        try {
            await putCreateOnly(client, bucket, createOnlyKey, bodyB, 'text/plain');
            secondPutSucceeded = true; // a DIFFERENT body landing = R2 did NOT enforce.
        } catch (err) { secondPutErr = err; }
        let afterGet = null;
        try { afterGet = await getObject(client, bucket, createOnlyKey); }
        catch (err) { afterGet = { error: classifyError(err) }; }
        checks.create_only_collision_rejected = evalCreateOnlyCollision({
            key: createOnlyKey, secondPutSucceeded, err: secondPutErr, afterGet, step2Etag, step2Sha,
        });
    }

    // ── Step 4: correct-ETag CAS succeeds ────────────────────────────────────
    let step4Etag = null, step4Sha = null;
    try {
        const initialPointer = Buffer.from(JSON.stringify({ v: 1, runId }), 'utf-8');
        await putCreateOnly(client, bucket, casKey, initialPointer, 'application/json');
        const seeded = await getObject(client, bucket, casKey);
        const correctEtag = seeded.etag;
        const updatedBody = Buffer.from(JSON.stringify({ v: 2, runId }), 'utf-8');
        await casPutTestKey(client, bucket, casKey, updatedBody, correctEtag);
        const after = await getObject(client, bucket, casKey);
        step4Etag = after.etag; step4Sha = after.sha256;
        const expectSha = sha256Hex(updatedBody);
        if (step4Sha !== expectSha) {
            fail('cas_correct_etag_succeeds', {
                action: `CAS PUT (IfMatch correct) ${casKey}`,
                reason: 'CAS reported success but stored body sha != expected',
                etag: step4Etag, sha256: step4Sha, expectedSha: expectSha,
            });
        } else {
            pass('cas_correct_etag_succeeds', {
                action: `CAS PUT (IfMatch correct) ${casKey}`,
                seededEtag: correctEtag, newEtag: step4Etag, sha256: step4Sha,
            });
        }
    } catch (err) {
        fail('cas_correct_etag_succeeds', {
            action: `CAS PUT (IfMatch correct) ${casKey}`,
            reason: 'correct-ETag CAS unexpectedly failed', error: classifyError(err),
        });
    }

    // ── Step 5: wrong-ETag CAS rejected (REAL enforcement + control) ─────────
    {
        const wrongEtag = '"00000000000000000000000000000000"';
        const wouldBeBody = Buffer.from(JSON.stringify({ v: 3, hijack: true, runId }), 'utf-8');
        let casErr = null, casSucceeded = false;
        try {
            await casPutTestKey(client, bucket, casKey, wouldBeBody, wrongEtag);
            casSucceeded = true; // non-enforcement of If-Match.
        } catch (err) { casErr = err; }
        let afterGet = null;
        try { afterGet = await getObject(client, bucket, casKey); }
        catch (err) { afterGet = { error: classifyError(err) }; }
        checks.cas_wrong_etag_rejected = evalCasWrongEtag({
            key: casKey, casSucceeded, err: casErr, afterGet, step4Etag, step4Sha,
        });
    }

    // TEST SEAM (unit tests only): force ONE unconditional PUT through the
    // instrumented client so the no-unconditional-PUT audit can be proven to CATCH
    // a wrapper that degraded a conditional write. Never set on a real run.
    if (opts.__injectUnconditionalPut) {
        try {
            await client.send(new PutObjectCommand({
                Bucket: bucket, Key: `${namespace}__inject-unconditional`,
                Body: Buffer.from('unconditional (test seam)\n', 'utf-8'), ContentType: 'text/plain',
            }));
        } catch { /* recorded regardless */ }
    }

    // ── Step 6: no unconditional PUT (from the instrumented send-log) ────────
    checks.no_unconditional_put = evalNoUnconditionalPut(summarizePutConditionals(client.sendLog));

    // ── Step 7: production latest invariance (AFTER) — read-only ─────────────
    {
        let prodAfter = null, getErr = null;
        try { prodAfter = await getObjectOrNull(client, bucket, PROD_LATEST_KEY); }
        catch (err) { getErr = err; }
        checks.prod_latest_after = getErr
            ? { pass: false, action: `GET ${PROD_LATEST_KEY} (read-only)`, error: classifyError(getErr) }
            : evalProdLatestInvariance(prodBefore, prodAfter);
    }

    const checkNames = [
        'prod_latest_before', 'create_only_first_put', 'create_only_collision_rejected',
        'cas_correct_etag_succeeds', 'cas_wrong_etag_rejected', 'no_unconditional_put',
        'prod_latest_after',
    ];
    const v1_pass = checkNames.every(n => checks[n] && checks[n].pass === true);

    return {
        harness: 'rk15-v1-verify', run_id: runId, commit_sha: commitSha, namespace,
        test_keys: { createOnlyKey, casKey },
        send_log: client.sendLog,
        put_conditional_summary: summarizePutConditionals(client.sendLog),
        checks, v1_pass,
    };
}

// ── CLI entry (real R2; founder-triggered workflow_dispatch only) ────────────

async function main() {
    const bucket = process.env.R2_BUCKET;
    const client = makeR2Client(); // throws loud if env not configured
    const report = await runHarness(client, bucket);
    const json = JSON.stringify(report, null, 2);
    writeFileSync(EVIDENCE_FILE, json);
    console.log(json);
    console.log('');
    console.log(printHumanSummary(report));
    process.exit(report.v1_pass ? 0 : 1);
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
    main().catch(err => {
        console.error('[rk15-v1-verify] FATAL:', err);
        try {
            writeFileSync(EVIDENCE_FILE, JSON.stringify({
                harness: 'rk15-v1-verify', fatal: true, error: classifyError(err), v1_pass: false,
            }, null, 2));
        } catch { /* best-effort */ }
        process.exit(1);
    });
}
