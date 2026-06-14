/**
 * RK-15 V3-A — the candidate BUILD/SEAL/VALIDATE/PROBE flow against the REAL
 * Run #1 aggregated source, into the PRODUCTION namespace, WITHOUT swapping
 * production latest.
 *
 * Source attestation: for ALL 22 AGGREGATED_FILES, HEAD ETag+size BEFORE the
 * download -> download -> re-HEAD ETag+size AFTER -> assert unchanged -> compute
 * local sha256 (over the EXACT bytes used) + line-count. downloadStageByRunId
 * returns EMPTY buffers for missing files (it does NOT throw), so the source
 * prefix is read here directly (GET/HEAD only) and EACH of the 22 is asserted
 * present + non-empty.
 *
 * Candidate flow REUSES the producer paths (NOT re-implemented):
 *   publishCompoundShards + publishNegShards + putCreateOnly (xref+search)
 *   -> buildAndSealCandidate -> validateCandidate -> a direct candidate probe.
 * It MUST NOT call swapV2Latest/postSwapActiveProbe/activateValidatedCandidate
 * against snapshots/latest.json. The candidate's v2 pointer payload is written
 * to an ISOLATED <prefix>_candidate_latest.json (UNDER the candidate prefix, so
 * the guard allows it; NOT production latest) and fed to the PURE
 * parseSnapshotContext for the read-back — yielding the EXACT payload V3-B
 * activates (drift-free).
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

import {
    objectPrefixFor, putCreateOnly, xrefIndexKey, searchProjectionKey,
    compoundsManifestKey, canonicalManifestHash,
} from '../factory/lib/snapshot-identity.js';
import { publishCompoundShards } from '../factory/lib/compound-shard-publisher.js';
import { publishNegShards } from '../factory/lib/neg-shard-publisher.js';
import { buildAndSealCandidate, validateCandidate, swapV2Latest } from '../factory/lib/stage-4-activate.js';
import { AGGREGATED_FILES } from '../factory/lib/aggregated-files.js';
import { SATELLITE_INVENTORY } from '../factory/lib/snapshot-inventory.js';
import { parseSnapshotContext } from '../../src/worker/lib/snapshot-context.ts';
import {
    FIXED_SOURCE_PREFIX, getObject, headObject, sha256Hex, lineCount,
} from './rk15-v3-lib.js';

/** The candidate's v2 pointer is written here — UNDER the candidate prefix, NOT
 * production latest. This is the EXACT payload V3-B will CAS into production. */
export function candidateLatestKey(objectPrefix) {
    return `${objectPrefix}_candidate_latest.json`;
}

export function candidateIdentity(date, runId, runAttempt, commitSha) {
    const snapshotId = `${date}/${runId}-${runAttempt}`;
    return { snapshotId, objectPrefix: objectPrefixFor(snapshotId), snapshotDate: date, runId, runAttempt, commitSha };
}

/**
 * Read + attest all 22 source files (HEAD before -> GET -> HEAD after ->
 * unchanged), using the candidate client (GET/HEAD only — the guard never sees
 * a source PUT). Returns { buffers, inventory, attestationHash }.
 */
export async function attestSource({ client, bucket }) {
    const inventory = [];
    const buffers = {};
    for (const fname of AGGREGATED_FILES) {
        const key = `${FIXED_SOURCE_PREFIX}${fname}`;
        let preHead;
        try { preHead = await headObject(client, bucket, key); }
        catch (err) { throw new Error(`[V3A SOURCE] required Run#1 file missing (pre-HEAD): ${key} (${err.message})`); }
        const got = await getObject(client, bucket, key);
        const postHead = await headObject(client, bucket, key);
        if (got.body.length === 0) throw new Error(`[V3A SOURCE] required Run#1 file is EMPTY: ${key}`);
        if (preHead.etag !== postHead.etag || preHead.size !== postHead.size) {
            throw new Error(`[V3A SOURCE] source object CHANGED during read (etag/size drift): ${key} pre=${preHead.etag}/${preHead.size} post=${postHead.etag}/${postHead.size}`);
        }
        buffers[fname] = got.body;
        inventory.push({ key, etag: postHead.etag, size: postHead.size, sha256: got.sha256, line_count: lineCount(got.body) });
    }
    const attestationHash = canonicalManifestHash({ source_prefix: FIXED_SOURCE_PREFIX, inventory });
    return { buffers, inventory, attestationHash };
}

/** Materialize the source bytes the producers consume on disk + derive the
 * gzipped xref/search projection bytes (exactly as the producer publishes them). */
async function stageSourceOnDisk(buffers) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rk15-v3a-src-'));
    const compoundsJsonl = path.join(dir, 'compounds-enriched.jsonl');
    const negJsonl = path.join(dir, 'neg-evidence.jsonl');
    await fs.writeFile(compoundsJsonl, buffers['compounds-enriched.jsonl']);
    await fs.writeFile(negJsonl, buffers['neg-evidence.jsonl']);
    const searchProjectionBytes = zlib.gzipSync(buffers['compounds-search.jsonl'], { level: 9 });
    const xrefIndexBytes = zlib.gzipSync(buffers['xref-index.json'], { level: 9 });
    return { dir, compoundsJsonl, negJsonl, searchProjectionBytes, xrefIndexBytes };
}

/**
 * RK-15 full-snapshot completeness: gzip + create-only PUT every SATELLITE_INVENTORY
 * serving file (papers/trials/trial-links/bioactivities/target-index/compounds-
 * enriched/neg-evidence whole-file) from the attested source buffers to the SAME
 * `<prefix><fname>.gz` keys the real F4 snapshot-builder publishes. gzipSync(level:9)
 * is byte-identical to the builder's createGzip(level:9). Returns the published keys.
 */
export async function publishSatelliteSnapshotFiles({ client, bucket, prefix, buffers }) {
    const keys = [];
    for (const entry of SATELLITE_INVENTORY) {
        const src = buffers[entry.snapshot_file];
        if (!src || src.length === 0) {
            throw new Error(`[V3A SATELLITE] required serving source missing/empty: ${entry.snapshot_file} (surface: ${entry.surface})`);
        }
        const key = `${prefix}${entry.key_suffix}`;
        const gz = zlib.gzipSync(src, { level: 9 });
        await putCreateOnly(client, bucket, key, gz, 'application/gzip');
        keys.push(key);
    }
    return keys;
}

/**
 * Build the candidate under the PRODUCTION prefix (create-only), seal LAST,
 * validate by its OWN keys, then write the candidate v2 pointer to the ISOLATED
 * _candidate_latest.json (NOT production latest). Returns the candidate evidence.
 */
export async function buildCandidate({ client, bucket, identity, buffers }) {
    const prefix = identity.objectPrefix;
    const staged = await stageSourceOnDisk(buffers);

    // 1) REAL compound shards (NXVF) + manifest, create-only under the prefix.
    const compound = await publishCompoundShards({
        client, bucket, jsonlPath: staged.compoundsJsonl, snapshotDate: identity.snapshotDate,
        outputDir: path.join(staged.dir, 'out', 'compounds', 'bucket-0000'), objectPrefix: prefix,
    });
    // 2) REAL neg shards + manifest, create-only.
    const neg = await publishNegShards({
        client, bucket, jsonlPath: staged.negJsonl, snapshotDate: identity.snapshotDate,
        outputRoot: path.join(staged.dir, 'out', 'neg'), objectPrefix: prefix,
    });
    const negManifestKey = neg.manifestKeys?.[0] ?? null;
    // 3) xref/routing + search/entity projection, create-only.
    await putCreateOnly(client, bucket, xrefIndexKey(prefix), staged.xrefIndexBytes, 'application/gzip');
    await putCreateOnly(client, bucket, searchProjectionKey(prefix), staged.searchProjectionBytes, 'application/gzip');
    // 3b) FULL-SNAPSHOT COMPLETENESS (RK-15 fix): publish EVERY satellite serving
    // file the readers require (papers/trials/trial-links/bioactivities/target-
    // index/compounds-enriched/neg-evidence whole-file), gzipped + create-only to
    // the SAME `<prefix><fname>.gz` keys a real F4 snapshot-builder publishes. The
    // V3-A defect was these being OMITTED -> satellites 503/404 after cutover.
    // Each is gzipped from the ATTESTED Run#1 source buffer (level 9 == builder).
    const satelliteKeys = await publishSatelliteSnapshotFiles({ client, bucket, prefix, buffers });
    // 4) seal LAST (OBJECTS_COMPLETE) then validate by the candidate's OWN keys.
    const { manifestHash } = await buildAndSealCandidate({
        client, bucket, identity, compoundManifest: compound.manifest,
        negManifestKey, hasXref: true, hasSearch: true, satelliteKeys,
    });
    await validateCandidate({ client, bucket, identity, expectedHash: manifestHash });

    // 5) write the candidate v2 pointer to the ISOLATED _candidate_latest.json
    // (under the candidate prefix; the guard allows it; it is NOT prod latest).
    const cmKey = compoundsManifestKey(prefix, compound.manifest.bucket ?? 0);
    const latestKey = candidateLatestKey(prefix);
    const latest = await swapV2Latest({
        client, bucket, identity, manifestHash, compoundsManifestKey: cmKey,
        negManifestKey, hasXref: true, latestKey,
    });
    return { snapshotId: identity.snapshotId, objectPrefix: prefix, manifestKey: cmKey, manifestHash, negManifestKey, compoundManifest: compound.manifest, latest, latestKey };
}

/**
 * Candidate probe that BYPASSES production latest: GET the isolated
 * _candidate_latest.json -> parseSnapshotContext (PURE, no production read) ->
 * resolve compound manifest/shards + xref + neg + search inventory + a direct
 * decode of `targetCid` from the REAL shard (assert the decoded CID matches).
 */
export async function candidateProbe({ client, bucket, prefix, latestKey, manifestKey, compoundManifest, negManifestKey, targetCid }) {
    const { decodeNxvfEntity } = await import('./rk15-v2-lib.js');
    const latestText = (await getObject(client, bucket, latestKey)).body.toString('utf-8');
    const candidatePayloadHash = sha256Hex(Buffer.from(latestText, 'utf-8'));
    const ctx = parseSnapshotContext(latestText);
    const checks = {};
    checks.reader_parses_candidate = {
        pass: ctx.layout_version === 'immutable_snapshot_v2' && ctx.snapshot_id && ctx.object_prefix === prefix,
        action: 'parseSnapshotContext(candidate payload) — production latest NOT read',
        snapshot_id: ctx.snapshot_id, object_prefix: ctx.object_prefix,
    };
    // Resolve the compound manifest + a real shard; decode targetCid.
    const manifest = JSON.parse((await getObject(client, bucket, ctx.compounds_manifest_key ?? manifestKey)).body.toString('utf-8'));
    const entry = (manifest.entries ?? []).find(e => e.cid === targetCid)
        ?? (manifest.entries ?? [])[0];
    let decodedCid = null;
    if (entry) {
        const bid = String(manifest.bucket ?? 0).padStart(4, '0');
        const shardKey = `${prefix}compounds/bucket-${bid}/shard-${String(entry.shard).padStart(3, '0')}.bin`;
        const shardBuf = (await getObject(client, bucket, shardKey)).body;
        const rec = JSON.parse((await decodeNxvfEntity(shardBuf, entry.offset, entry.size)).toString('utf-8'));
        decodedCid = rec.pubchem_cid;
    }
    checks.compound_cid_decodes = {
        pass: entry != null && (targetCid == null || decodedCid === targetCid),
        action: 'decode a CID directly from the real candidate shard', requested_cid: targetCid, decoded_cid: decodedCid,
    };
    // xref / neg / search inventory present + non-empty.
    const xrefHead = await headObject(client, bucket, ctx.xref_index_key ?? xrefIndexKey(prefix)).catch(() => null);
    const searchHead = await headObject(client, bucket, searchProjectionKey(prefix)).catch(() => null);
    const negHead = negManifestKey ? await headObject(client, bucket, negManifestKey).catch(() => null) : null;
    checks.inventory_resolves = {
        pass: !!xrefHead && xrefHead.size > 0 && !!searchHead && searchHead.size > 0 && (!negManifestKey || (!!negHead && negHead.size > 0)),
        action: 'xref/routing + negative-evidence + search/entity inventory resolve',
        xref: !!xrefHead, search: !!searchHead, neg: negManifestKey ? !!negHead : 'n/a',
    };
    const pass = Object.values(checks).every(c => c.pass);
    return { pass, checks, candidatePayload: latestText, candidatePayloadHash, parsedSnapshotId: ctx.snapshot_id };
}
