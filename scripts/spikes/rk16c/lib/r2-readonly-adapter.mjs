/**
 * RK-16C FULL-CORPUS SPIKE (H) — STRICT READ-ONLY R2 CORPUS ACQUISITION ADAPTER.
 *
 * SAFE BY DEFAULT: --dry-run performs NO network call; it computes the EXACT
 * TWO snapshot-namespace keys (manifest + payload; M1 removed the mutable
 * snapshots/latest.json alias from EVERY read path) + estimates.
 *
 * TWO-STAGE (M3), both BUILD-inert here: --preflight is METADATA-ONLY (manifest
 * key only, small byte cap, NO payload GET; under a future gate emits the lock
 * from manifest pins + payload pins read FROM THE MANIFEST BODY); --execute is
 * the FULL RUN — it loads + require()s a COMPLETE founder-reviewed LOCK BEFORE
 * any payload GET (fail-before-network), then STREAMS the payload GET (never
 * landing a decompressed file) and verifies sha256/size against the lock.
 *
 * Every read is wrapped by the STRICTER instrumentExactReadOnlyClient (M2):
 * ONLY HeadObject/GetObject of an ALLOWLISTED key; List/discovery, any
 * non-allowlisted key, any PUT/DELETE/COPY/multipart, any latest resolution all
 * THROW before the store. Memory + disk guards (M4) apply. NO fabricated hashes.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
    consumedObjectKeys, bioactivitiesObjectKey, manifestObjectKey,
    fileManifestObjectKey, objectPrefixOf,
    CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT, proposeIdentity,
} from './corpus-identity.mjs';
import { instrumentExactReadOnlyClient } from './exact-readonly-guard.mjs';
import { loadAndRequireLock } from './fullcorpus-lock.mjs';
import {
    validateRootSeal, validateFileManifest, deriveFileManifestKey,
    normalizeSatelliteInventory, reconcileFilesWithInventory, extractBioactivitiesEntry,
    assembleCandidateLock,
} from './two-manifest-preflight.mjs';
import {
    startMemoryMonitor, requireDiskPreflight, memorySample,
} from './resource-guard.mjs';

/** HARD caps — fail-closed past any (a runaway read is a defect, not a retry). */
export const MAX_REQUESTS = 8;                  // <=2 metadata objects x (HEAD+GET) + slack
export const MAX_OBJECTS = 2;                   // exactly TWO metadata objects (seal + manifest.json) / full-run: seal+payload
export const MAX_TOTAL_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB payload ceiling
// D-103 §9 metadata byte caps. The seal + per-file manifest are small (a handful
// of KiB each in production); 2 MiB per object is a bounded, far-from-unlimited
// ceiling (NOT arbitrary), and 4 MiB combined caps both reads. Cap breach FAILS
// CLOSED before candidate-lock creation.
export const MAX_ROOT_MANIFEST_BYTES = 2 * 1024 * 1024;  // root seal cap (2 MiB)
export const MAX_FILE_MANIFEST_BYTES = 2 * 1024 * 1024;  // per-file manifest cap (2 MiB)
export const MAX_METADATA_TOTAL_BYTES = MAX_ROOT_MANIFEST_BYTES + MAX_FILE_MANIFEST_BYTES; // 4 MiB
export const MAX_MANIFEST_BYTES = MAX_ROOT_MANIFEST_BYTES; // back-compat alias (root seal cap)
/** Per-object byte estimate for the satellite (compressed gz, EXPECTED-ONLY). */
export const EST_BIOACTIVITIES_BYTES = 60 * 1024 * 1024; // ~60 MiB est (gz)
export const EST_MANIFEST_BYTES = 64 * 1024;

export function redact(s) {
    if (s == null) return s;
    return String(s)
        .replace(/(access[_-]?key[_-]?id["':=\s]*)([^\s"',}]+)/gi, '$1***REDACTED***')
        .replace(/(secret[_-]?access[_-]?key["':=\s]*)([^\s"',}]+)/gi, '$1***REDACTED***')
        .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***REDACTED***@')
        .replace(/[A-Za-z0-9]{32,}/g, (m) => (m.length >= 40 ? '***REDACTED***' : m));
}
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

/**
 * Compute the dry-run plan (NO network). The proposed object keys = exactly the
 * TWO snapshot-namespace keys (manifest, payload). NO latest alias anywhere.
 */
export function computeDryRunPlan(opts = {}) {
    const snapshotId = opts.snapshot || CANDIDATE_SNAPSHOT_ID;
    const expectedRows = opts.expectedRows != null ? opts.expectedRows : EXPECTED_ROW_COUNT;
    const keys = consumedObjectKeys(snapshotId); // [manifest, payload] — no latest
    const identity = proposeIdentity({
        snapshot_id: snapshotId, expected_row_count: expectedRows,
        build_commit: opts.buildCommit || null,
    });
    const estimated_request_count = keys.length * 2; // 1 HEAD + 1 GET per object
    const estimated_total_bytes = EST_MANIFEST_BYTES + EST_BIOACTIVITIES_BYTES;
    return {
        mode: 'dry-run',
        snapshot_id: snapshotId,
        expected_row_count: expectedRows,
        proposed_object_keys: keys,
        allowlist: keys,
        forbidden_keys: ['snapshots/latest.json'], // M1: never in any read path
        estimated_request_count,
        estimated_object_count: keys.length,
        estimated_total_bytes,
        hard_caps: {
            max_requests: MAX_REQUESTS, max_objects: MAX_OBJECTS,
            max_total_bytes: MAX_TOTAL_BYTES, max_manifest_bytes: MAX_MANIFEST_BYTES,
        },
        per_object_byte_estimates: {
            [manifestObjectKey(snapshotId)]: EST_MANIFEST_BYTES,
            [bioactivitiesObjectKey(snapshotId)]: EST_BIOACTIVITIES_BYTES,
        },
        identity_envelope: identity,
        network_performed: false,
        within_caps: estimated_request_count <= MAX_REQUESTS
            && keys.length <= MAX_OBJECTS
            && estimated_total_bytes <= MAX_TOTAL_BYTES,
    };
}

/** Local destination OUTSIDE the repo (os.tmpdir()) for materialized bytes. */
export function materializationDir(snapshotId = CANDIDATE_SNAPSHOT_ID) {
    const safe = snapshotId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(os.tmpdir(), `rk16c-fullcorpus-${safe}`);
}

/** Atomically materialize the VERIFIED COMPRESSED bytes (temp-then-rename). */
export function atomicMaterialize(dir, fileName, body, expectedSize) {
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, fileName);
    const tmpPath = `${finalPath}.partial-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, body);
    const written = fs.statSync(tmpPath).size;
    if (expectedSize != null && written !== expectedSize) {
        fs.unlinkSync(tmpPath);
        throw new Error(`[rk16c-adapter] PARTIAL DOWNLOAD for ${fileName}: wrote ${written} bytes, expected ${expectedSize} — fail-closed`);
    }
    fs.renameSync(tmpPath, finalPath);
    return finalPath;
}

/** Remove a materialization directory (the cleanup command). */
export function cleanup(snapshotId = CANDIDATE_SNAPSHOT_ID) {
    const dir = materializationDir(snapshotId);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        return { removed: true, dir };
    }
    return { removed: false, dir };
}

/** Best-effort execution provenance for the candidate lock (null off-Actions). */
function readProvenance() {
    const run = process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
        : null;
    return {
        workflow_run: run,
        runner_sha: process.env.AUDITED_RUNNER_SHA || process.env.GITHUB_SHA || null,
        workflow_sha: process.env.WORKFLOW_DEFINITION_SHA || process.env.GITHUB_SHA || null,
    };
}

/**
 * STAGE 1+2 — TWO-MANIFEST METADATA-ONLY PREFLIGHT (D-103 A1). Reads EXACTLY two
 * metadata objects under the validated immutable prefix — the root seal then the
 * deterministic per-file manifest sibling — and NEVER the payload. Stage 1
 * validates the seal (identity + recomputed manifest_hash + payload exactly once
 * in satellite_inventory). The per-file manifest key is then derived from the
 * VALIDATED object_prefix and asserted equal to the allowlisted sibling key
 * BEFORE the second read. Stage 2 validates the per-file manifest, reconciles
 * files[] against the satellite inventory, and extracts the bioactivities pins.
 * Returns an assembled UNRATIFIED candidate lock. Refuses unless execute===true
 * AND a snapshot pin AND --manifest-key === the exact seal key.
 */
export async function preflightManifest(opts, deps) {
    if (opts.execute !== true) {
        throw new Error('[rk16c-adapter] refusing preflight: --execute not set (default is dry-run)');
    }
    if (!opts.snapshot) {
        throw new Error('[rk16c-adapter] refusing preflight: no snapshot pin supplied');
    }
    const snapshotId = opts.snapshot;
    const sealKey = manifestObjectKey(snapshotId);
    const manifestKey = opts.manifestKey || sealKey;
    if (manifestKey !== sealKey) {
        throw new Error(`[rk16c-adapter] preflight manifest-key mismatch: ${manifestKey} != ${sealKey} — fail-closed`);
    }
    const payloadKey = bioactivitiesObjectKey(snapshotId);
    // The per-file manifest key is the deterministic sibling — derived ONLY from
    // the pinned snapshot prefix, NEVER from caller input/List/latest. It is
    // re-asserted against the VALIDATED seal object_prefix before Stage 2.
    const fileManifestKey = fileManifestObjectKey(snapshotId);
    // EXACT allowlist = the TWO metadata keys ONLY (no payload, ever).
    const guarded = deps.instrument(deps.makeClient(), [sealKey, fileManifestKey]);

    // ---- Stage 1: root seal ----
    const sealHead = await deps.headObject(guarded, deps.bucket, sealKey);
    if ((sealHead.size || 0) > MAX_ROOT_MANIFEST_BYTES) {
        throw new Error(`[rk16c-adapter] root-manifest byte cap exceeded (HEAD ${sealHead.size} > ${MAX_ROOT_MANIFEST_BYTES}) — fail-closed BEFORE GET`);
    }
    const sealGot = await deps.getObject(guarded, deps.bucket, sealKey);
    const sealSha = sha256(sealGot.body);
    const sealFacts = validateRootSeal(sealGot.body, { snapshotId, payloadKey });
    // FAIL BEFORE SECOND READ if the derived sibling key (from the validated
    // object_prefix) does not equal the allowlisted/expected sibling key.
    const derivedFileKey = deriveFileManifestKey(sealFacts.object_prefix);
    if (derivedFileKey !== fileManifestKey) {
        throw new Error(`[rk16c-adapter] derived per-file manifest key ${derivedFileKey} != expected ${fileManifestKey} — FAIL BEFORE SECOND METADATA READ`);
    }

    // ---- Stage 2: deterministic per-file manifest sibling ----
    const fmHead = await deps.headObject(guarded, deps.bucket, fileManifestKey);
    if ((fmHead.size || 0) > MAX_FILE_MANIFEST_BYTES) {
        throw new Error(`[rk16c-adapter] per-file manifest byte cap exceeded (HEAD ${fmHead.size} > ${MAX_FILE_MANIFEST_BYTES}) — fail-closed BEFORE GET`);
    }
    const fmGot = await deps.getObject(guarded, deps.bucket, fileManifestKey);
    const fmSha = sha256(fmGot.body);
    if ((sealGot.size + fmGot.size) > MAX_METADATA_TOTAL_BYTES) {
        throw new Error(`[rk16c-adapter] combined metadata byte cap exceeded (${sealGot.size}+${fmGot.size} > ${MAX_METADATA_TOTAL_BYTES}) — fail-closed`);
    }
    const fmFacts = validateFileManifest(fmGot.body, { snapshotId, objectPrefix: sealFacts.object_prefix });

    // ---- reconciliation + target pins ----
    const normSats = normalizeSatelliteInventory(sealFacts.satellite_inventory, sealFacts.object_prefix);
    const projection = reconcileFilesWithInventory(fmFacts.files, normSats);
    const payloadFilename = payloadKey.slice(sealFacts.object_prefix.length);
    const pins = extractBioactivitiesEntry(projection, payloadFilename);

    const candidate = assembleCandidateLock({
        seal: sealFacts,
        fileManifest: fmFacts,
        payloadKey,
        payloadFilename,
        pins,
        rootManifestRead: { key: sealKey, etag: sealHead.etag, byte_size: sealGot.size, sha256: sealSha },
        fileManifestRead: { key: fileManifestKey, etag: fmHead.etag, byte_size: fmGot.size, sha256: fmSha },
        expectedRowCount: opts.expectedRows,
        provenance: readProvenance(),
    });

    return {
        mode: 'preflight',
        network_performed: true,
        snapshot_id: snapshotId,
        root_manifest_key: sealKey,
        file_manifest_key: fileManifestKey,
        payload_key: payloadKey,
        candidate,
        requests_used: guarded.callCount,
        list_attempt_count: guarded.list_attempt_count,
        non_allowlisted_key_attempt_count: guarded.non_allowlisted_key_attempt_count,
        note: 'METADATA-ONLY (A1): two metadata objects read (seal + manifest.json); NO payload GET. Lock is UNRATIFIED + founder-gated.',
    };
}

/**
 * STAGE 2 — FULL RUN (future founder gate). Loads + require()s a COMPLETE lock
 * BEFORE any client/network (fail-before-network), runs the disk free-space
 * preflight + memory monitor, then STREAMS the payload GET (no decompressed
 * file), verifies sha256/size against the lock pins, returns the envelope.
 * @param {object} deps { makeClient, instrument, headObject, getObject, bucket } */
export async function executeFullRun(opts, deps) {
    if (opts.execute !== true) {
        throw new Error('[rk16c-adapter] refusing full run: --execute not set (default is dry-run)');
    }
    // FAIL BEFORE NETWORK: a complete lock is the ONLY accepted input.
    const lock = loadAndRequireLock(opts.lockPath); // throws (no client) if incomplete
    // FAIL BEFORE NETWORK: a candidate is UNRATIFIED until the founder flips it.
    if (lock.authorized_for_payload_read !== true) {
        throw new Error('[rk16c-adapter] refusing full run: lock is not founder-authorized for payload read (authorized_for_payload_read !== true) — FAIL BEFORE NETWORK');
    }
    const snapshotId = lock.snapshot_id;
    const payloadKey = lock.payload_key;
    const allowlist = new Set([lock.root_manifest_key, payloadKey]);
    const dir = materializationDir(snapshotId);
    requireDiskPreflight(os.tmpdir(), { compressedBytes: lock.payload_compressed_bytes }); // FAIL BEFORE NETWORK
    const mem = startMemoryMonitor(opts.memory || {});

    // Only NOW (after lock + disk preflight) may a client exist / network occur.
    const guarded = deps.instrument(deps.makeClient(), allowlist);
    let requests = 0;
    const charge = () => {
        requests += 1;
        if (requests > MAX_REQUESTS) {
            mem.stop();
            throw new Error(`[rk16c-adapter] request cap exceeded (${requests} > ${MAX_REQUESTS}) — fail-closed`);
        }
    };

    try {
        charge();
        const head = await deps.headObject(guarded, deps.bucket, payloadKey);
        if ((head.size || 0) > MAX_TOTAL_BYTES) {
            throw new Error(`[rk16c-adapter] byte cap exceeded (HEAD ${head.size} > ${MAX_TOTAL_BYTES}) — fail-closed BEFORE GET`);
        }
        if (lock.payload_compressed_bytes != null && head.size != null && head.size !== lock.payload_compressed_bytes) {
            throw new Error(`[rk16c-adapter] payload size != lock pin (HEAD ${head.size} != ${lock.payload_compressed_bytes}) — fail-closed BEFORE GET`);
        }
        charge();
        // STREAMING GET: hash + land the VERIFIED COMPRESSED file only; the gzip
        // is NEVER decompressed to disk (no decompressed file is written).
        const got = await deps.getObject(guarded, deps.bucket, payloadKey);
        if (got.size > MAX_TOTAL_BYTES) {
            throw new Error(`[rk16c-adapter] byte cap exceeded after GET (${got.size} > ${MAX_TOTAL_BYTES}) — fail-closed`);
        }
        const downloadedSha = sha256(got.body);
        if (lock.payload_sha256_compressed && downloadedSha !== lock.payload_sha256_compressed) {
            throw new Error(`[rk16c-adapter] payload sha256 != lock pin: lock=${lock.payload_sha256_compressed} got=${downloadedSha} — fail-closed, NOT used`);
        }
        const localPath = atomicMaterialize(dir, 'bioactivities.jsonl.gz', got.body, head.size);

        const identity = proposeIdentity({
            snapshot_id: snapshotId, expected_row_count: lock.expected_row_count,
            build_commit: opts.buildCommit || null,
        });
        identity.object_byte_size = got.size;
        identity.etag = head.etag;
        identity.sha256 = downloadedSha;
        identity.local_materialization_path = localPath;
        identity.materialization_timestamp = new Date().toISOString();
        identity.verification_status = 'VERIFIED';

        mem.sample();
        return {
            mode: 'execute',
            network_performed: true,
            requests_used: requests,
            bytes_downloaded: got.size,
            decompressed_file_written: false, // STREAMED — proved by no-decompressed-file test
            read_command_counts: guarded.readCounts,
            put_count: guarded.put_count,
            delete_count: guarded.delete_count,
            list_count: guarded.list_count,
            write_attempt_count: guarded.write_attempt_count,
            peak_memory: mem.peak,
            memory_breached: mem.breached,
            memory_failure: mem.failure,
            identity_envelope: identity,
            local_materialization_path: localPath,
        };
    } finally {
        mem.stop();
    }
}

export { memorySample };
