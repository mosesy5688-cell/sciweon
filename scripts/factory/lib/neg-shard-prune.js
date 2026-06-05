/**
 * NegEvidence old-shard prune — PR-T1.1-LEVER.
 *
 * Consumption model: loaders read readLatestPointer -> serve the LATEST
 * snapshot only. OLD-date neg shards are never consumed; the per-date
 * whole-file neg-evidence.jsonl.gz is the PRESERVED base (additive bulk).
 * So old-date shards can be pruned for storage, KEEPING:
 *   - every date's whole-file (snapshots/<date>/neg-evidence.jsonl.gz) — NEVER pruned
 *   - the latest date's shards
 *   - the last `keepN` snapshots' shards
 *   - and NEVER the date latest.json points to.
 *
 * decidePruneTargets is PURE (list in -> list of prune-able dates out) so it is
 * unit-testable without R2. The IO wrapper deletes only the shard prefix
 * (snapshots/<date>/neg-evidence/bucket-*) — it never touches the whole-file.
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

/**
 * @param dates  ALL snapshot dates that currently have neg shards (strings).
 * @param pointerDate  the date snapshots/latest.json points to (never pruned).
 * @param keepN  keep the last N snapshots' shards (default 2).
 * @returns { prune: string[], keep: string[] } — dates whose shards to prune.
 */
export function decidePruneTargets(dates, pointerDate, keepN = 2) {
    const uniq = [...new Set(dates.filter(Boolean))].sort(); // ascending
    // Keep set: the pointer date + the most-recent keepN dates.
    const keep = new Set();
    if (pointerDate) keep.add(pointerDate);
    for (const d of uniq.slice(-Math.max(0, keepN))) keep.add(d);
    const prune = uniq.filter(d => !keep.has(d));
    return { prune, keep: [...keep].sort() };
}

const NEG_SHARD_PREFIX = (date) => `snapshots/${date}/neg-evidence/`;

async function listKeys(client, bucket, prefix) {
    const keys = [];
    let token;
    do {
        const res = await client.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, ContinuationToken: token,
        }));
        for (const o of res.Contents ?? []) keys.push(o.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

/**
 * List the snapshot dates that currently carry neg shards (a bucket-N entry
 * under snapshots/<date>/neg-evidence/).
 */
export async function listNegShardDates(client, bucket) {
    const res = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: 'snapshots/', Delimiter: '/',
    }));
    const dates = new Set();
    // Two-level: list date prefixes, then probe neg-evidence/ presence.
    const datePrefixes = (res.CommonPrefixes ?? []).map(p => p.Prefix); // snapshots/<date>/
    for (const dp of datePrefixes) {
        const m = /snapshots\/([^/]+)\//.exec(dp);
        if (!m) continue;
        const date = m[1];
        if (date === 'latest.json') continue;
        const negKeys = await listKeys(client, bucket, `${NEG_SHARD_PREFIX(date)}bucket-`);
        if (negKeys.length > 0) dates.add(date);
    }
    return [...dates];
}

/**
 * IO wrapper: prune the shard prefix for each prune-target date. Deletes ONLY
 * snapshots/<date>/neg-evidence/bucket-* — the whole-file
 * snapshots/<date>/neg-evidence.jsonl.gz is NOT under that prefix and is never
 * touched. Run AFTER the swap + drain.
 */
export async function pruneOldNegShards(client, bucket, pointerDate, keepN = 2) {
    const dates = await listNegShardDates(client, bucket);
    const { prune, keep } = decidePruneTargets(dates, pointerDate, keepN);
    let deleted = 0;
    for (const date of prune) {
        const keys = await listKeys(client, bucket, `${NEG_SHARD_PREFIX(date)}bucket-`);
        // Defense: never delete a whole-file (it is not under bucket-*), assert.
        const offending = keys.filter(k => !k.includes('/neg-evidence/bucket-'));
        if (offending.length > 0) {
            throw new Error(`[NEG-PRUNE] Refusing to delete non-shard keys: ${offending.slice(0, 3).join(', ')}`);
        }
        for (let i = 0; i < keys.length; i += 1000) {
            const batch = keys.slice(i, i + 1000);
            await client.send(new DeleteObjectsCommand({
                Bucket: bucket, Delete: { Objects: batch.map(Key => ({ Key })) },
            }));
            deleted += batch.length;
        }
        console.log(`[NEG-PRUNE] Pruned ${keys.length} shard keys for ${date}`);
    }
    return { prunedDates: prune, keptDates: keep, deletedKeys: deleted };
}

export { S3Client };
