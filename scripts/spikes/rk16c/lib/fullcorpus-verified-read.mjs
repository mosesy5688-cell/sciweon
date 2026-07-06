/**
 * RK-16C FULL-CORPUS PAYLOAD RUN - metadata reconciliation + streaming decode.
 *
 * reconcileMetadata: reads EXACTLY the two metadata objects (root seal then the
 * deterministic sibling manifest), validates them, and RECONCILES them against the
 * ratified lock (keys, snapshot identity, root_manifest_sha256, file_manifest_sha256)
 * BEFORE any payload GET. Any mismatch throws -> the payload is never requested.
 *
 * streamDecodeVerify: gunzips the (already compressed-sha-verified) payload buffer
 * as a STREAM, updating an uncompressed sha256 + counting rows (newline-delimited
 * jsonl) chunk-by-chunk. The decompressed content is NEVER accumulated as a whole
 * nor written to disk; only the incremental hash + counters are retained.
 */

import zlib from 'zlib';
import { createHash } from 'crypto';
import { manifestObjectKey, fileManifestObjectKey, bioactivitiesObjectKey } from './corpus-identity.mjs';
import { validateRootSeal, validateFileManifest } from './two-manifest-preflight.mjs';

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
const FAIL = (m) => { throw new Error(`[rk16c-fullrun-recon] ${m}`); };

/**
 * Read + reconcile the two metadata manifests against the lock BEFORE payload GET.
 * @param {object} guarded  exact-readonly-guard-wrapped client
 * @param {object} deps     { headObject, getObject, bucket }
 * @param {object} lock     the ratified lock
 */
export async function reconcileMetadata(guarded, deps, lock) {
    const snapshotId = lock.snapshot_id;
    // Keys must equal the DETERMINISTIC derivations (never List/latest/free-text).
    if (lock.root_manifest_key !== manifestObjectKey(snapshotId)) FAIL(`root_manifest_key ${lock.root_manifest_key} != deterministic seal key - fail-closed BEFORE PAYLOAD GET`);
    if (lock.file_manifest_key !== fileManifestObjectKey(snapshotId)) FAIL(`file_manifest_key ${lock.file_manifest_key} != deterministic sibling key - fail-closed BEFORE PAYLOAD GET`);
    if (lock.payload_key !== bioactivitiesObjectKey(snapshotId)) FAIL(`payload_key ${lock.payload_key} != deterministic payload key - fail-closed BEFORE PAYLOAD GET`);

    // ---- Stage 1: root seal (read + validate + sha reconcile) ----
    await deps.headObject(guarded, deps.bucket, lock.root_manifest_key);
    const sealGot = await deps.getObject(guarded, deps.bucket, lock.root_manifest_key);
    const sealSha = sha256(sealGot.body);
    if (sealSha !== lock.root_manifest_sha256) FAIL(`root seal sha256 != lock pin: lock=${lock.root_manifest_sha256} got=${sealSha} - fail-closed BEFORE PAYLOAD GET`);
    const sealFacts = validateRootSeal(sealGot.body, { snapshotId });
    if (sealFacts.snapshot_id !== snapshotId) FAIL(`root seal snapshot identity mismatch - fail-closed BEFORE PAYLOAD GET`);

    // ---- Stage 2: sibling manifest (read + validate + sha reconcile) ----
    await deps.headObject(guarded, deps.bucket, lock.file_manifest_key);
    const fmGot = await deps.getObject(guarded, deps.bucket, lock.file_manifest_key);
    const fmSha = sha256(fmGot.body);
    if (fmSha !== lock.file_manifest_sha256) FAIL(`sibling manifest sha256 != lock pin: lock=${lock.file_manifest_sha256} got=${fmSha} - fail-closed BEFORE PAYLOAD GET`);
    const fmFacts = validateFileManifest(fmGot.body, { snapshotId, objectPrefix: sealFacts.object_prefix });

    return {
        sealFacts, fmFacts,
        root_manifest_sha256_ok: true,
        file_manifest_sha256_ok: true,
        keys_ok: true,
        snapshot_identity_ok: true,
    };
}

/**
 * Stream-decode a gzip buffer WITHOUT landing the decompressed content on disk or
 * in a single buffer. Returns { rows, uncompressedBytes, sha256_uncompressed }.
 * Rows = newline-delimited lines (a non-newline-terminated final line still counts).
 */
export function streamDecodeVerify(compressedBuffer, opts = {}) {
    return new Promise((resolve, reject) => {
        const gunzip = zlib.createGunzip();
        const hash = createHash('sha256');
        let rows = 0;
        let uncompressedBytes = 0;
        let endsWithNewline = true;
        gunzip.on('data', (chunk) => {
            hash.update(chunk);
            uncompressedBytes += chunk.length;
            for (let i = 0; i < chunk.length; i++) { if (chunk[i] === 0x0A) rows += 1; }
            if (chunk.length > 0) endsWithNewline = chunk[chunk.length - 1] === 0x0A;
            if (opts.monitor && typeof opts.monitor.sample === 'function') opts.monitor.sample();
        });
        gunzip.on('end', () => {
            if (uncompressedBytes > 0 && !endsWithNewline) rows += 1; // final unterminated line
            resolve({ rows, uncompressedBytes, sha256_uncompressed: hash.digest('hex') });
        });
        gunzip.on('error', (e) => reject(new Error(`[rk16c-fullrun-decode] gunzip failed: ${e?.message ?? e}`)));
        gunzip.end(compressedBuffer);
    });
}
