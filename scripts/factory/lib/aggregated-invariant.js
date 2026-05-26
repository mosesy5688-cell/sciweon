/**
 * Pre-upload invariant guard for stage-3-aggregate.js (PR-CORE-MERGE-LEAK).
 *
 * Runs AFTER all F3 stages complete (cumulative-merge, aggregated-backfill,
 * OT merge, SID stampers, indices) and BEFORE uploadStage('aggregated',...).
 * Reads the prev cycle's published source-completeness state from R2 and
 * compares the final local compounds-enriched.jsonl's fully_enriched
 * counters. Hard-fails if any monitored bucket regressed.
 *
 * Per [[cross_cycle_silent_data_loss]] zero-tolerance: caught regressions
 * never get published. The R2 state stays at the prior cycle's healthy
 * snapshot, providing a race-free comparison origin for next-cycle retry.
 *
 * Bootstrap-safe: missing state file -> warn + skip (first deploy / wipe
 * reset cannot get stuck in a validation catch-22).
 */

import fs from 'fs/promises';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const STATE_KEY = 'state/source-completeness.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length > 0) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

// Predicate matches source-required-fields.js:115-118 unichem required_paths:
// external_ids.unii non-null AND external_ids.sources includes "unichem".
export function countFullyEnrichedUnichem(records) {
    let count = 0;
    for (const r of records) {
        const ext = r?.external_ids;
        if (!ext) continue;
        if (ext.unii == null || ext.unii === '') continue;
        if (!Array.isArray(ext.sources) || !ext.sources.includes('unichem')) continue;
        count++;
    }
    return count;
}

async function loadLocalCompounds(localPath) {
    const content = await fs.readFile(localPath, 'utf-8');
    const out = [];
    for (const line of content.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed; not invariant's concern */ }
    }
    return out;
}

async function fetchPrevState(client, bucket) {
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY }));
        const buf = await streamToBuffer(res.Body);
        return JSON.parse(buf.toString());
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

/**
 * Run the invariant guard. Returns {checked, prev, current, delta} on success;
 * THROWS on regression detection (caller MUST NOT swallow the throw -- the
 * R2 publish must not proceed if invariant fails).
 *
 * @param {object} opts
 * @param {string} opts.localCompoundsPath Path to final post-F3 compounds-enriched.jsonl
 * @param {string} [opts.label] Log prefix (default '[INVARIANT-GATE]')
 */
export async function enforceCompletenessInvariant({ localCompoundsPath, label = '[INVARIANT-GATE]' }) {
    let client, bucket;
    try {
        client = makeR2Client();
        bucket = process.env.R2_BUCKET;
    } catch (err) {
        console.warn(`${label} R2 client init failed (${err.message}) -- skipping invariant check (bootstrap-safe)`);
        return { checked: false, reason: 'r2_client_init_failed' };
    }

    const prevState = await fetchPrevState(client, bucket);
    if (!prevState) {
        console.warn(`${label} Prior completeness state not found on R2 (${STATE_KEY}) -- bootstrap or first-run; skipping invariant check`);
        return { checked: false, reason: 'prev_state_missing' };
    }
    const prevCount = Number(prevState?.sources?.unichem?.fully_enriched) || 0;

    const finalCompounds = await loadLocalCompounds(localCompoundsPath);
    const currentCount = countFullyEnrichedUnichem(finalCompounds);

    const delta = currentCount - prevCount;
    if (currentCount < prevCount) {
        throw new Error(
            `${label} CRITICAL REGRESSION DETECTED: unichem fully_enriched dropped ${prevCount} -> ${currentCount} (delta=${delta}). ` +
            `Cumulative-merge data leak suspected (PR-CORE-MERGE-LEAK class). Halting R2 publish per [[cross_cycle_silent_data_loss]] zero-tolerance.`
        );
    }
    console.log(`${label} Invariant verified green | unichem fully_enriched: ${prevCount} -> ${currentCount} (delta=${delta > 0 ? '+' : ''}${delta}) | total_compounds=${finalCompounds.length}`);
    return { checked: true, prev: prevCount, current: currentCount, delta, totalCompounds: finalCompounds.length };
}
