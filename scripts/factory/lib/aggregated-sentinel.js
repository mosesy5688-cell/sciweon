/**
 * V0.5.5 — Cumulative aggregation sentinel + merge decision logic.
 *
 * Fixes [[feedback_cross_cycle_silent_data_loss]] recurrence in stage-3:
 * the V0.5.2.1 merge had a silent-skip clause `prevPointer.run_id === runId`
 * that produced 2026-05-18 production data regression (-83%). Root cause
 * audit found a *second* silent-loss mode beyond the skip clause: when
 * `latest.json` points at a partially-written bundle (stage-3 crashed
 * mid-upload), `downloadStageByRunId` returns empty buffers and the merge
 * runs against empty previous, silently clobbering historical data.
 *
 * Two guards (must work together):
 *   1. `first_run_complete` sentinel at processed/aggregated/first_run_complete
 *      distinguishes legitimate first-run skip from "we forgot to merge" —
 *      sentinel set + pointer missing == operator surgery, hard-abort
 *   2. Non-empty buffer verify (caller responsibility) — refuses to merge
 *      when previous compounds-enriched.jsonl has <100 bytes (effectively
 *      empty / partial-upload-crash signal)
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const SENTINEL_KEY = 'processed/aggregated/first_run_complete';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeClient() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

export async function readFirstRunSentinel() {
    try {
        const client = makeClient();
        await client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: SENTINEL_KEY,
        }));
        return true;
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
        throw err;
    }
}

export async function writeFirstRunSentinel(runId) {
    const client = makeClient();
    const body = JSON.stringify({ first_run: runId, marked_at: new Date().toISOString() }, null, 2);
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: SENTINEL_KEY,
        Body: Buffer.from(body),
        ContentType: 'application/json',
    }));
}

/**
 * Pure function: decide merge action from inputs.
 * Extracted from stage-3-aggregate.js merge block for unit testing
 * (no R2 dependencies — easy to fuzz against all 5 decision branches).
 *
 * Decision matrix:
 *   no sentinel + no pointer             → first_run_skip       (legitimate bootstrap)
 *   sentinel    + no pointer             → sentinel_present_pointer_missing (operator surgery — hard abort)
 *   pointer present but run_id missing   → pointer_missing_run_id (foreign-writer schema — hard abort)
 *   pointer.run_id === runId             → same_run_skip        (workflow_dispatch re-run, safe skip)
 *   pointer valid but prev buffer empty  → empty_buffer_abort   (partial upload crash — hard abort)
 *   pointer valid + prev buffer non-empty → merge               (happy path)
 *
 * Legacy bootstrap upgrade: a R2 with valid pointer but no sentinel (existing
 * deployment that ran V0.5.2.1 without sentinel) takes the `merge` branch
 * because `prevBufferNonEmpty=true` overrides the missing-sentinel check.
 */
export function decideMergeAction({ prevPointer, runId, firstRunDone, prevBufferNonEmpty }) {
    if (!firstRunDone && !prevPointer) return { kind: 'first_run_skip' };
    if (firstRunDone && !prevPointer) return { kind: 'sentinel_present_pointer_missing' };
    if (prevPointer && !prevPointer.run_id) return { kind: 'pointer_missing_run_id' };
    if (prevPointer?.run_id === runId) return { kind: 'same_run_skip' };
    if (prevPointer?.run_id && !prevBufferNonEmpty) return { kind: 'empty_buffer_abort' };
    return { kind: 'merge' };
}
