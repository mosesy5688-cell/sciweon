/**
 * RK-16C FULL-CORPUS SPIKE (H) — READ-ONLY R2 CORPUS ACQUISITION ADAPTER.
 *
 * SAFE BY DEFAULT. With no flags (or --dry-run) it performs NO network call: it
 * computes + returns the EXACT proposed production object keys + estimated
 * request count + estimated total bytes from the pinned corpus identity ALONE.
 *
 * A real read happens ONLY when BOTH `execute === true` AND a full corpus
 * identity (snapshot_id) is supplied. Even then every safety rail applies:
 *   - explicit object ALLOWLIST (default-deny; only the pinned keys);
 *   - explicit snapshot PIN (never follows latest);
 *   - read-only ops only — the real client is wrapped by the P8R1
 *     instrumentReadOnlyClient so List/Head/Get pass and any PUT/DELETE/COPY/
 *     latest-mutation THROWS before reaching the store;
 *   - bounded request count + bounded byte count (hard caps, fail-closed);
 *   - local destination OUTSIDE the repo (os.tmpdir());
 *   - atomic materialization (temp-then-rename); partial-download detection;
 *   - sha256 verification before use (fail-closed on mismatch);
 *   - credential redaction in all logs; a cleanup() command.
 *
 * This module NEVER calls makeR2Client in dry-run. The caller injects a client
 * factory for the execute path so the dry-run path has ZERO R2 dependency.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
    consumedObjectKeys, bioactivitiesObjectKey, manifestObjectKey,
    LATEST_POINTER_KEY, CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT, proposeIdentity,
} from './corpus-identity.mjs';

/** HARD caps — fail-closed past either (a runaway read is a defect, not a retry). */
export const MAX_REQUESTS = 12;                 // 3 keys x (HEAD+GET) + slack
export const MAX_TOTAL_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB ceiling
/** Per-object byte estimate for the satellite (compressed gz, EXPECTED-ONLY). */
export const EST_BIOACTIVITIES_BYTES = 60 * 1024 * 1024; // ~60 MiB est (gz)
export const EST_MANIFEST_BYTES = 64 * 1024;
export const EST_LATEST_BYTES = 8 * 1024;

/** Redact anything credential-shaped from a string before it is logged. */
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
 * Compute the dry-run plan (NO network). Returns the proposed identity envelope,
 * the exact ordered object keys, the estimated request count + total bytes, the
 * allowlist, and the bounded caps. This is what `--dry-run` prints verbatim.
 */
export function computeDryRunPlan(opts = {}) {
    const snapshotId = opts.snapshot || CANDIDATE_SNAPSHOT_ID;
    const expectedRows = opts.expectedRows != null ? opts.expectedRows : EXPECTED_ROW_COUNT;
    const keys = consumedObjectKeys(snapshotId);
    const identity = proposeIdentity({
        snapshot_id: snapshotId, expected_row_count: expectedRows,
        build_commit: opts.buildCommit || null,
    });
    // request estimate: 1 HEAD + 1 GET per object (no List — keys are explicit).
    const estimated_request_count = keys.length * 2;
    const estimated_total_bytes =
        EST_LATEST_BYTES + EST_MANIFEST_BYTES + EST_BIOACTIVITIES_BYTES;
    return {
        mode: 'dry-run',
        snapshot_id: snapshotId,
        expected_row_count: expectedRows,
        proposed_object_keys: keys,
        allowlist: keys,
        estimated_request_count,
        estimated_total_bytes,
        hard_caps: { max_requests: MAX_REQUESTS, max_total_bytes: MAX_TOTAL_BYTES },
        per_object_byte_estimates: {
            [LATEST_POINTER_KEY]: EST_LATEST_BYTES,
            [manifestObjectKey(snapshotId)]: EST_MANIFEST_BYTES,
            [bioactivitiesObjectKey(snapshotId)]: EST_BIOACTIVITIES_BYTES,
        },
        identity_envelope: identity,
        network_performed: false,
        within_caps: estimated_request_count <= MAX_REQUESTS
            && estimated_total_bytes <= MAX_TOTAL_BYTES,
    };
}

/** Local destination OUTSIDE the repo (os.tmpdir()) for materialized bytes. */
export function materializationDir(snapshotId = CANDIDATE_SNAPSHOT_ID) {
    const safe = snapshotId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(os.tmpdir(), `rk16c-fullcorpus-${safe}`);
}

/**
 * Atomically materialize bytes to disk (temp-then-rename) + detect partial
 * downloads (expected size mismatch). Returns the final path.
 */
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
 * EXECUTE path (real read). Refuses unless execute===true AND a snapshot pin is
 * supplied. Wraps the injected real client with the P8R1 read-only guard,
 * enforces the allowlist + caps, materializes atomically, verifies sha256
 * against the pinned identity, and returns the filled identity envelope.
 *
 * @param {object} deps  { makeClient, instrument, headObject, getObject, bucket }
 *   injected so the dry-run path keeps ZERO R2 dependency + tests can mock.
 */
export async function executeRead(opts, deps) {
    if (opts.execute !== true) {
        throw new Error('[rk16c-adapter] refusing remote read: --execute not set (default is dry-run)');
    }
    if (!opts.snapshot) {
        throw new Error('[rk16c-adapter] refusing remote read: no full corpus-identity (snapshot pin) supplied');
    }
    const snapshotId = opts.snapshot;
    const allowlist = new Set(consumedObjectKeys(snapshotId));
    const pinned = {
        snapshot_id: snapshotId,
        expected_sha256: opts.expectedSha256 || null,
        expected_row_count: opts.expectedRows != null ? opts.expectedRows : EXPECTED_ROW_COUNT,
    };
    const guarded = deps.instrument(deps.makeClient());
    const dir = materializationDir(snapshotId);

    let requests = 0;
    let totalBytes = 0;
    const charge = (n) => {
        requests += n;
        if (requests > MAX_REQUESTS) {
            throw new Error(`[rk16c-adapter] request cap exceeded (${requests} > ${MAX_REQUESTS}) — fail-closed`);
        }
    };

    const corpusKey = bioactivitiesObjectKey(snapshotId);
    if (!allowlist.has(corpusKey)) {
        throw new Error(`[rk16c-adapter] ${corpusKey} not in allowlist — fail-closed`);
    }
    charge(1);
    const head = await deps.headObject(guarded, deps.bucket, corpusKey);
    if ((head.size || 0) > MAX_TOTAL_BYTES) {
        throw new Error(`[rk16c-adapter] byte cap exceeded (HEAD size ${head.size} > ${MAX_TOTAL_BYTES}) — fail-closed BEFORE GET`);
    }
    charge(1);
    const got = await deps.getObject(guarded, deps.bucket, corpusKey);
    totalBytes += got.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`[rk16c-adapter] byte cap exceeded after GET (${totalBytes} > ${MAX_TOTAL_BYTES}) — fail-closed`);
    }
    const localPath = atomicMaterialize(dir, 'bioactivities.jsonl.gz', got.body, head.size);
    const downloadedSha = sha256(got.body);
    if (pinned.expected_sha256 && downloadedSha !== pinned.expected_sha256) {
        fs.unlinkSync(localPath);
        throw new Error(`[rk16c-adapter] sha256 mismatch: pinned=${pinned.expected_sha256} downloaded=${downloadedSha} — fail-closed, NOT used`);
    }

    const identity = proposeIdentity({
        snapshot_id: snapshotId, expected_row_count: pinned.expected_row_count,
        build_commit: opts.buildCommit || null,
    });
    identity.object_byte_size = got.size;
    identity.etag = head.etag;
    identity.sha256 = downloadedSha;
    identity.local_materialization_path = localPath;
    identity.materialization_timestamp = new Date().toISOString();
    identity.verification_status = pinned.expected_sha256 ? 'VERIFIED' : 'HASH_RECORDED_NO_PIN';

    return {
        mode: 'execute',
        network_performed: true,
        requests_used: requests,
        bytes_downloaded: totalBytes,
        read_command_counts: guarded.readCounts,
        put_count: guarded.put_count,
        delete_count: guarded.delete_count,
        write_attempt_count: guarded.write_attempt_count,
        identity_envelope: identity,
        local_materialization_path: localPath,
    };
}
