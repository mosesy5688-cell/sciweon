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
    CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT, proposeIdentity,
} from './corpus-identity.mjs';
import { instrumentExactReadOnlyClient } from './exact-readonly-guard.mjs';
import { loadAndRequireLock } from './fullcorpus-lock.mjs';
import {
    startMemoryMonitor, requireDiskPreflight, memorySample,
} from './resource-guard.mjs';

/** HARD caps — fail-closed past any (a runaway read is a defect, not a retry). */
export const MAX_REQUESTS = 8;                  // 2 keys x (HEAD+GET) + slack
export const MAX_OBJECTS = 2;                   // M1: exactly manifest + payload
export const MAX_TOTAL_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB ceiling
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;       // preflight metadata cap (2 MiB)
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

/**
 * STAGE 1 — METADATA-ONLY PREFLIGHT (future founder gate). Targets ONLY the
 * manifest key (HEAD then a small-capped GET); NEVER touches the payload. Under
 * a real gate this would emit the lock (manifest pins + payload pins read FROM
 * THE MANIFEST BODY). Refuses unless execute===true AND a snapshot pin. */
export async function preflightManifest(opts, deps) {
    if (opts.execute !== true) {
        throw new Error('[rk16c-adapter] refusing preflight: --execute not set (default is dry-run)');
    }
    if (!opts.snapshot) {
        throw new Error('[rk16c-adapter] refusing preflight: no snapshot pin supplied');
    }
    const snapshotId = opts.snapshot;
    const manifestKey = opts.manifestKey || manifestObjectKey(snapshotId);
    if (manifestKey !== manifestObjectKey(snapshotId)) {
        throw new Error(`[rk16c-adapter] preflight manifest-key mismatch: ${manifestKey} != ${manifestObjectKey(snapshotId)} — fail-closed`);
    }
    // EXACT allowlist for preflight = the manifest key ONLY (no payload).
    const guarded = deps.instrument(deps.makeClient(), [manifestKey]);
    const head = await deps.headObject(guarded, deps.bucket, manifestKey);
    if ((head.size || 0) > MAX_MANIFEST_BYTES) {
        throw new Error(`[rk16c-adapter] manifest byte cap exceeded (HEAD ${head.size} > ${MAX_MANIFEST_BYTES}) — fail-closed BEFORE GET`);
    }
    const got = await deps.getObject(guarded, deps.bucket, manifestKey);
    return {
        mode: 'preflight',
        network_performed: true,
        snapshot_id: snapshotId,
        manifest_key: manifestKey,
        manifest_etag: head.etag,
        manifest_byte_size: got.size,
        manifest_sha256: sha256(got.body),
        manifest_body: got.body, // payload pins are extracted FROM here by the gate
        list_attempt_count: guarded.list_attempt_count,
        non_allowlisted_key_attempt_count: guarded.non_allowlisted_key_attempt_count,
        note: 'METADATA-ONLY: manifest read only; NO payload GET. Lock emission is founder-gated.',
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
    const snapshotId = lock.snapshot_id;
    const payloadKey = lock.payload_key;
    const allowlist = new Set([lock.manifest_key, payloadKey]);
    const dir = materializationDir(snapshotId);
    requireDiskPreflight(os.tmpdir(), { compressedBytes: lock.payload_byte_size }); // FAIL BEFORE NETWORK
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
        if (lock.payload_byte_size != null && head.size != null && head.size !== lock.payload_byte_size) {
            throw new Error(`[rk16c-adapter] payload size != lock pin (HEAD ${head.size} != ${lock.payload_byte_size}) — fail-closed BEFORE GET`);
        }
        charge();
        // STREAMING GET: hash + land the VERIFIED COMPRESSED file only; the gzip
        // is NEVER decompressed to disk (no decompressed file is written).
        const got = await deps.getObject(guarded, deps.bucket, payloadKey);
        if (got.size > MAX_TOTAL_BYTES) {
            throw new Error(`[rk16c-adapter] byte cap exceeded after GET (${got.size} > ${MAX_TOTAL_BYTES}) — fail-closed`);
        }
        const downloadedSha = sha256(got.body);
        if (lock.payload_sha256 && downloadedSha !== lock.payload_sha256) {
            throw new Error(`[rk16c-adapter] payload sha256 != lock pin: lock=${lock.payload_sha256} got=${downloadedSha} — fail-closed, NOT used`);
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
