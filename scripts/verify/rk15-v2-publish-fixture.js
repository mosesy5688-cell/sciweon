/**
 * RK-15 V2 — publish the deterministic fixture to an ISOLATED prefix using the
 * REAL producer code paths (NOT a re-implementation):
 *   - publishCompoundShards      (compound-shard-publisher.js)  -> real NXVF shards
 *   - publishNegShards           (neg-shard-publisher.js)       -> real neg shards
 *   - putCreateOnly              (snapshot-identity.js)         -> xref + search
 *   - buildAndSealCandidate      (stage-4-activate.js)          -> root seal LAST
 *   - validateCandidate          (stage-4-activate.js)          -> full inventory
 *   - swapV2Latest (isolated latestKey) + postSwapActiveProbe   -> CAS + ACTIVE
 *
 * The object_prefix is composed UNDER the isolated root so deriveSnapshotId /
 * the v2 key layout are reused but every key lands at
 * rk15-verification/v2/{session}/snapshots/{date}/{runId}-{attempt}/.
 */

import path from 'path';
import {
    deriveSnapshotId, objectPrefixFor, putCreateOnly,
    xrefIndexKey, searchProjectionKey, compoundsManifestKey,
} from '../factory/lib/snapshot-identity.js';
import { publishCompoundShards } from '../factory/lib/compound-shard-publisher.js';
import { publishNegShards } from '../factory/lib/neg-shard-publisher.js';
import { buildAndSealCandidate, validateCandidate, swapV2Latest, postSwapActiveProbe } from '../factory/lib/stage-4-activate.js';
import { getObject, headObject } from './rk15-v2-lib.js';

/** Compose the isolated object_prefix UNDER rk15-verification/v2/{session}/. The
 * production layout (snapshots/<date>/<runId>-<attempt>/) is REUSED verbatim,
 * just rooted in the isolated namespace. */
export function isolatedRoot(sessionId) {
    return `rk15-verification/v2/${sessionId}/`;
}
export function isolatedLatestKey(sessionId) {
    return `${isolatedRoot(sessionId)}latest.json`;
}
export function isolatedIdentity(sessionId, date, runId, runAttempt, commitSha) {
    const snapshotId = deriveSnapshotId(date, runId, runAttempt);
    const objectPrefix = `${isolatedRoot(sessionId)}${objectPrefixFor(snapshotId)}`;
    return { snapshotId, objectPrefix, snapshotDate: date, runId, runAttempt, commitSha };
}

/** Publish ALL object classes create-only under the isolated prefix, then seal,
 * validate, CAS the isolated latest, and confirm ACTIVE. Returns the evidence. */
export async function publishAndActivate({ client, bucket, identity, fixture, latestKey }) {
    const prefix = identity.objectPrefix;

    // 1) REAL compound shards (NXVF via shard-writer) + manifest, create-only.
    const compound = await publishCompoundShards({
        client, bucket, jsonlPath: fixture.compoundsJsonl, snapshotDate: identity.snapshotDate,
        outputDir: path.join(fixture.dir, 'out', 'compounds', 'bucket-0000'), objectPrefix: prefix,
    });

    // 2) REAL neg shards + manifest, create-only.
    const neg = await publishNegShards({
        client, bucket, jsonlPath: fixture.negJsonl, snapshotDate: identity.snapshotDate,
        outputRoot: path.join(fixture.dir, 'out', 'neg'), objectPrefix: prefix,
    });
    const negManifestKey = neg.manifestKeys[0] ?? null;

    // 3) xref/routing + search/entity projection objects, create-only.
    await putCreateOnly(client, bucket, xrefIndexKey(prefix), fixture.xrefIndexBytes, 'application/gzip');
    await putCreateOnly(client, bucket, searchProjectionKey(prefix), fixture.searchProjectionBytes, 'application/gzip');

    // 4) seal LAST (OBJECTS_COMPLETE) then validate by candidate's OWN keys.
    const { manifestHash } = await buildAndSealCandidate({
        client, bucket, identity, compoundManifest: compound.manifest,
        negManifestKey, hasXref: true, hasSearch: true,
    });
    await validateCandidate({ client, bucket, identity, expectedHash: manifestHash });

    // 5) CAS the ISOLATED latest pointer + post-swap ACTIVE probe.
    const cmKey = compoundsManifestKey(prefix, compound.manifest.bucket ?? 0);
    const latest = await swapV2Latest({
        client, bucket, identity, manifestHash, compoundsManifestKey: cmKey,
        negManifestKey, hasXref: true, latestKey,
    });
    const active = await postSwapActiveProbe({ client, bucket, identity, manifestHash, latestKey });

    return {
        snapshotId: identity.snapshotId, objectPrefix: prefix,
        manifestKey: cmKey, manifestHash, negManifestKey,
        compoundManifest: compound.manifest, negResult: neg,
        latest, activeState: active.state,
    };
}

/** HEAD every object under a prefix's known inventory -> { key: {etag,size} }.
 * Reuses the manifest's declared shards so it is the REAL object set, not a guess. */
export async function snapshotInventory({ client, bucket, prefix, compoundManifest, negManifestKey }) {
    const inv = {};
    const add = async (key) => { inv[key] = await headObject(client, bucket, key); };
    await add(`${prefix}_snapshot.manifest.json`);
    await add(compoundsManifestKey(prefix, compoundManifest.bucket ?? 0));
    for (const sh of compoundManifest.shard_hashes ?? []) {
        await add(`${prefix}compounds/bucket-${String(compoundManifest.bucket ?? 0).padStart(4, '0')}/shard-${String(sh.shard).padStart(3, '0')}.bin`);
    }
    if (negManifestKey) await add(negManifestKey);
    await add(xrefIndexKey(prefix));
    await add(searchProjectionKey(prefix));
    return inv;
}

/** Read a compound manifest + its shard bytes back from R2 (serving read-back). */
export async function readManifestAndShards({ client, bucket, manifestKey, prefix, bucketId = 0 }) {
    const mf = JSON.parse((await getObject(client, bucket, manifestKey)).body.toString('utf-8'));
    const shardBytes = new Map();
    for (const sh of mf.shard_hashes ?? []) {
        const key = `${prefix}compounds/bucket-${String(bucketId).padStart(4, '0')}/shard-${String(sh.shard).padStart(3, '0')}.bin`;
        shardBytes.set(sh.shard, (await getObject(client, bucket, key)).body);
    }
    return { manifest: mf, shardBytes };
}
