/**
 * publish-shards-and-swap — the ONE terminal swap path.
 *
 * Extracts the shared "publish shards -> drain wait -> verifyShardIntegrity
 * (N random-shard sha256 re-fetch) -> ONE terminal swapLatestPointer" flow so
 * BOTH the compound publish (stage-4) and the neg publish funnel through a
 * single atomic pointer swap that merges ALL keys at once. Before this, the
 * compound block + the snapshot-uploader each wrote latest.json separately
 * (a last-writer-wins race that could drop a sibling manifest key).
 *
 * swapLatestPointer: read-merge ALL keys (latest_snapshot_date, manifest_key,
 * compounds_manifest_key, neg_evidence_manifest_key) with PutObjectCommand
 * IfMatch CAS + retry-on-412, then a post-swap re-read asserting all expected
 * keys are present.
 *
 * IfMatch decision (see PR report (e)): R2's conditional-PUT honoring is not
 * probe-able here, so the IfMatch is the OPTIMISTIC primary and a bounded
 * read-merge-write retry loop is the backstop; the post-swap re-read is the
 * final correctness assertion either way.
 */

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const SWAP_MAX_RETRIES = 6;
const LATEST_KEY = 'snapshots/latest.json';

async function streamToString(body) {
    const chunks = [];
    for await (const c of body) chunks.push(c);
    return Buffer.concat(chunks).toString('utf-8');
}

async function getLatest(client, bucket) {
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_KEY }));
        const etag = res.ETag;
        const json = JSON.parse(await streamToString(res.Body));
        return { json, etag };
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return { json: {}, etag: null };
        }
        throw err;
    }
}

function isPreconditionFailed(err) {
    return err.name === 'PreconditionFailed'
        || err.$metadata?.httpStatusCode === 412
        || /precondition/i.test(err.message ?? '');
}

/**
 * Atomic latest.json swap. `updates` is a partial object of pointer keys to
 * set (e.g. { latest_snapshot_date, compounds_manifest_key,
 * neg_evidence_manifest_key }). `expectKeys` is the list of keys that MUST be
 * present in the re-read after the swap (the post-swap assertion).
 */
export async function swapLatestPointer(client, bucket, updates, expectKeys = []) {
    let lastErr = null;
    for (let attempt = 1; attempt <= SWAP_MAX_RETRIES; attempt++) {
        const { json: current, etag } = await getLatest(client, bucket);
        const merged = { ...current, ...updates };
        // FIX M4: a null/undefined update value CLEARS that key from latest.json
        // (true removal, not a `"key": null` residue). The stage-4 orchestrator
        // sets neg_evidence_manifest_key=null on a skipped-neg run to drop a stale
        // prior-day key; dropping it here makes the worker's dual-path see it ABSENT
        // -> legacy whole-file path (vs a 503 on a shard-less date).
        for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === undefined) delete merged[k];
        }
        // Preserve a derivable manifest_key if neither side supplied one.
        if (!merged.manifest_key && merged.latest_snapshot_date) {
            merged.manifest_key = `snapshots/${merged.latest_snapshot_date}/manifest.json`;
        }
        const put = {
            Bucket: bucket, Key: LATEST_KEY,
            Body: JSON.stringify(merged), ContentType: 'application/json',
        };
        // IfMatch CAS when we have a current etag; IfNoneMatch:* for first-create.
        if (etag) put.IfMatch = etag;
        else put.IfNoneMatch = '*';
        try {
            await client.send(new PutObjectCommand(put));
        } catch (err) {
            lastErr = err;
            if (isPreconditionFailed(err)) {
                // Concurrent writer won the race — re-GET, re-merge, retry.
                continue;
            }
            // R2 may reject the conditional header itself (NotImplemented/400).
            // Fall back to an unconditional read-merge-write for this attempt.
            if (/not implemented|invalidargument|badrequest|conditional/i.test(err.message ?? '')
                || err.$metadata?.httpStatusCode === 400 || err.$metadata?.httpStatusCode === 501) {
                delete put.IfMatch; delete put.IfNoneMatch;
                await client.send(new PutObjectCommand(put));
            } else {
                throw err;
            }
        }
        // Post-swap re-read assertion: ALL expected keys must be present.
        const { json: after } = await getLatest(client, bucket);
        const missing = expectKeys.filter(k => after[k] === undefined || after[k] === null);
        if (missing.length === 0) {
            return after;
        }
        // A concurrent writer clobbered an expected key — retry the merge.
        lastErr = new Error(`Post-swap re-read missing keys: ${missing.join(', ')}`);
    }
    throw new Error(`[SWAP] latest.json swap failed after ${SWAP_MAX_RETRIES} attempts: ${lastErr?.message}`);
}

/**
 * Shared publish flow: publish (caller-provided) -> drain wait -> integrity
 * probes -> return the publish result. The terminal swap is invoked SEPARATELY
 * by stage-4 ONCE after BOTH compound + neg publishes complete, so there is a
 * single pointer write per F4.
 */
export async function publishWithDrainAndVerify({
    label, publishFn, verifyFn, manifestForVerify, drainMs = 90_000, sampleCount = 3,
}) {
    console.log(`[PUBLISH] ${label}: publishing shards...`);
    const result = await publishFn();
    console.log(`[PUBLISH] ${label}: drain wait ${drainMs / 1000}s (Constitution V16.1 §9)`);
    await new Promise(r => setTimeout(r, drainMs));
    if (verifyFn && manifestForVerify) {
        console.log(`[PUBLISH] ${label}: integrity probes (${sampleCount} random shards)`);
        await verifyFn(manifestForVerify, sampleCount);
        console.log(`[PUBLISH] ${label}: integrity probes PASS`);
    }
    return result;
}
