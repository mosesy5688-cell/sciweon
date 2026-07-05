/**
 * RK-16C FULL-CORPUS SPIKE - FULL-RUN EXECUTE PATH (M3/M4) + materialization
 * helpers. Split out of r2-readonly-adapter.mjs for the 250-line monolith cap;
 * BEHAVIOUR IS UNCHANGED. The full run loads + require()s a COMPLETE
 * founder-authorized lock BEFORE any client/network (fail-before-network), runs
 * the disk free-space + memory guards, then STREAMS the payload GET (never landing
 * a decompressed file) and verifies sha256/size against the lock pins.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { CANDIDATE_SNAPSHOT_ID, proposeIdentity } from './corpus-identity.mjs';
import { loadAndRequireLock } from './fullcorpus-lock.mjs';
import { startMemoryMonitor, requireDiskPreflight } from './resource-guard.mjs';

/** Shared request/byte caps (also consumed by the dry-run planner via the adapter
 *  re-export). Fail-closed past any (a runaway read is a defect, not a retry). */
export const MAX_REQUESTS = 8;                          // <=2 objects x (HEAD+GET) + slack
export const MAX_TOTAL_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB payload ceiling

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

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
        throw new Error(`[rk16c-adapter] PARTIAL DOWNLOAD for ${fileName}: wrote ${written} bytes, expected ${expectedSize} - fail-closed`);
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
 * STAGE 2 - FULL RUN (future founder gate). Loads + require()s a COMPLETE lock
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
        throw new Error('[rk16c-adapter] refusing full run: lock is not founder-authorized for payload read (authorized_for_payload_read !== true) - FAIL BEFORE NETWORK');
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
            throw new Error(`[rk16c-adapter] request cap exceeded (${requests} > ${MAX_REQUESTS}) - fail-closed`);
        }
    };

    try {
        charge();
        const head = await deps.headObject(guarded, deps.bucket, payloadKey);
        if ((head.size || 0) > MAX_TOTAL_BYTES) {
            throw new Error(`[rk16c-adapter] byte cap exceeded (HEAD ${head.size} > ${MAX_TOTAL_BYTES}) - fail-closed BEFORE GET`);
        }
        if (lock.payload_compressed_bytes != null && head.size != null && head.size !== lock.payload_compressed_bytes) {
            throw new Error(`[rk16c-adapter] payload size != lock pin (HEAD ${head.size} != ${lock.payload_compressed_bytes}) - fail-closed BEFORE GET`);
        }
        charge();
        // STREAMING GET: hash + land the VERIFIED COMPRESSED file only; the gzip
        // is NEVER decompressed to disk (no decompressed file is written).
        const got = await deps.getObject(guarded, deps.bucket, payloadKey);
        if (got.size > MAX_TOTAL_BYTES) {
            throw new Error(`[rk16c-adapter] byte cap exceeded after GET (${got.size} > ${MAX_TOTAL_BYTES}) - fail-closed`);
        }
        const downloadedSha = sha256(got.body);
        if (lock.payload_sha256_compressed && downloadedSha !== lock.payload_sha256_compressed) {
            throw new Error(`[rk16c-adapter] payload sha256 != lock pin: lock=${lock.payload_sha256_compressed} got=${downloadedSha} - fail-closed, NOT used`);
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
            decompressed_file_written: false, // STREAMED - proved by no-decompressed-file test
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
