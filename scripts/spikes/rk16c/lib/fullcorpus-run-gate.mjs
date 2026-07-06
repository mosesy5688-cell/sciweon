/**
 * RK-16C FULL-CORPUS PAYLOAD-RUN GATE (D-129 wiring; BUILD-ONLY).
 *
 * The ratified-lock-gated payload runner. It is CLI-reachable ONLY through the
 * explicit `--full-run --lock <path>` path (preflight-control.selectAction) and
 * FAILS BEFORE ANY NETWORK unless EVERY ratified constant binds:
 *   - the lock FILE sha256 equals the ratified pin (wrong/tampered artifact -> fail);
 *   - the lock is structurally complete (validateLock);
 *   - an EXPLICIT payload-read grant is present (--authorized-for-payload-read flag
 *     OR the env the future D-134 gate sets) -- the artifact's OWN
 *     authorized_for_payload_read field is NEVER trusted;
 *   - schema / snapshot_id / payload_key / payload sha256 (compressed+uncompressed)
 *     / expected_row_count / trust-anchor fields each equal the ratified pins.
 * Only AFTER the gate + disk preflight + memory monitor does a client exist. Then
 * the root seal + sibling manifest are read + reconciled against the lock BEFORE
 * any payload GET; the payload GET streams the COMPRESSED bytes (verified sha256
 * before trust), and the gzip is stream-decoded IN MEMORY (uncompressed sha256 +
 * row count verified) so NO decompressed file is ever written to disk.
 */

import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import { validateLock } from './fullcorpus-lock.mjs';
import { requireDiskPreflight, startMemoryMonitor } from './resource-guard.mjs';
import { materializationDir, atomicMaterialize, MAX_TOTAL_BYTES } from './fullcorpus-execute.mjs';
import { reconcileMetadata, streamDecodeVerify } from './fullcorpus-verified-read.mjs';

/** The sha256 of the EXACT founder-ratified lock FILE bytes (D-129 pin). */
export const RATIFIED_LOCK_FILE_SHA256 = 'e6383dfe6df0895b827ab85c6d970418c86d87f9e5749d7bc850a4e313c909bd';
/** The env the FUTURE D-134 run gate sets to grant an explicit payload read. */
export const PAYLOAD_READ_AUTHZ_ENV = 'RK16C_D134_PAYLOAD_READ_AUTHORIZED';
/** The exact ratified integrity/identity constants a passing lock MUST equal. */
export const RATIFIED_PINS = Object.freeze({
    candidate_lock_schema: 'rk16c-fullcorpus-lock-v2',
    snapshot_id: '2026-06-14/27502029137-1',
    payload_key: 'snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz',
    payload_sha256_compressed: '4fe46a756b0492a3cd24fb3e7034f63a352b907fa9dd9ddd203d77fead7f203f',
    payload_sha256_uncompressed: '652d1b2884ec13e8c89b52f830596d6be6cca9e70e9085634d6442907f655d38',
    expected_row_count: 475112,
    trust_anchor_mode: 'producer-contract-derived-sibling-v1',
    payload_membership_authority: 'required_satellite_ssot',
    payload_pin_authority: 'sibling_manifest_files',
});
const FORBIDDEN_LATEST = 'snapshots/latest.json';
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
const FAIL = (m) => { throw new Error(`[rk16c-fullrun] ${m}`); };

/** The EXACT run allowlist: root seal + sibling manifest + payload key ONLY. The
 *  payload key is allowlisted ONLY here (never on the metadata-only preflight). */
export function fullRunAllowlist(lock) {
    return [lock.root_manifest_key, lock.file_manifest_key, lock.payload_key];
}

/** Explicit payload-read grant (NOT the artifact field). Flag OR the D-134 env. */
export function isPayloadReadAuthorized(opts = {}) {
    return opts.authorizedForPayloadRead === true || process.env[PAYLOAD_READ_AUTHZ_ENV] === '1';
}

/**
 * FAIL-BEFORE-NETWORK gate. THROWS on any missing/mismatched pin BEFORE a client
 * can exist. `opts.pins` / `opts.expectedLockSha256` are TEST-ONLY injection seams
 * (default = the ratified constants above); the CLI path passes neither.
 */
export function assertRatifiedLockGate(lockPath, opts = {}) {
    const pins = opts.pins || RATIFIED_PINS;
    const expectedFileSha = opts.expectedLockSha256 || RATIFIED_LOCK_FILE_SHA256;
    if (!lockPath) FAIL('no --lock path supplied - FAIL BEFORE NETWORK (the payload run accepts ONLY the founder-ratified lock)');
    if (!fs.existsSync(lockPath)) FAIL(`lock file not found at ${lockPath} - FAIL BEFORE NETWORK`);
    const raw = fs.readFileSync(lockPath);
    const fileSha = sha256(raw);
    if (fileSha !== expectedFileSha) FAIL(`lock file sha256 != ratified pin: expected=${expectedFileSha} got=${fileSha} - FAIL BEFORE NETWORK (wrong/tampered lock artifact)`);
    let lock;
    try { lock = JSON.parse(raw.toString('utf-8')); }
    catch (e) { FAIL(`lock file is not valid JSON: ${e?.message ?? e}`); }
    const v = validateLock(lock);
    if (!v.ok) FAIL(`lock structurally invalid - FAIL BEFORE NETWORK:\n  - ${v.errors.join('\n  - ')}`);
    // EXPLICIT grant required; the artifact's OWN authorized_for_payload_read is
    // NEVER trusted (it is false by design, and a true value does NOT authorize).
    if (!isPayloadReadAuthorized(opts)) {
        FAIL(`no explicit payload-read authorization grant (need --authorized-for-payload-read or ${PAYLOAD_READ_AUTHZ_ENV}=1) - FAIL BEFORE NETWORK; the artifact authorized_for_payload_read field is NOT trusted`);
    }
    const checks = [
        ['candidate_lock_schema', pins.candidate_lock_schema],
        ['snapshot_id', pins.snapshot_id],
        ['payload_key', pins.payload_key],
        ['payload_sha256_compressed', pins.payload_sha256_compressed],
        ['payload_sha256_uncompressed', pins.payload_sha256_uncompressed],
        ['expected_row_count', pins.expected_row_count],
        ['trust_anchor_mode', pins.trust_anchor_mode],
        ['payload_membership_authority', pins.payload_membership_authority],
        ['payload_pin_authority', pins.payload_pin_authority],
    ];
    for (const [field, want] of checks) {
        if (lock[field] !== want) FAIL(`lock ${field} != ratified pin: expected=${JSON.stringify(want)} got=${JSON.stringify(lock[field])} - FAIL BEFORE NETWORK`);
    }
    if (lock.root_directly_references_file_manifest !== false) FAIL('lock root_directly_references_file_manifest must be exactly false - FAIL BEFORE NETWORK');
    if (lock.payload_key === FORBIDDEN_LATEST) FAIL('payload_key must never be the latest alias - FAIL BEFORE NETWORK (latest.json / List / discovery are NEVER required)');
    return lock;
}

function buildReport({ lock, recon, guarded, got, decoded, disk, mem, localPath }) {
    return {
        mode: 'full-run',
        output_kind: 'supplemental-spike-envelope+row-count-hash+parameter-candidate',
        network_performed: true,
        requests_used: guarded.callCount,
        read_command_counts: guarded.readCounts,
        put_count: guarded.put_count,
        delete_count: guarded.delete_count,
        list_count: guarded.list_count,
        write_attempt_count: guarded.write_attempt_count,
        non_allowlisted_key_attempt_count: guarded.non_allowlisted_key_attempt_count,
        reconciliation: {
            root_manifest_sha256_ok: recon.root_manifest_sha256_ok,
            file_manifest_sha256_ok: recon.file_manifest_sha256_ok,
            keys_ok: recon.keys_ok,
            snapshot_identity_ok: recon.snapshot_identity_ok,
        },
        payload_compressed_bytes: got.size,
        payload_uncompressed_bytes: decoded.uncompressedBytes,
        rows_decoded: decoded.rows,
        payload_sha256_compressed: lock.payload_sha256_compressed,
        payload_sha256_uncompressed: decoded.sha256_uncompressed,
        decompressed_file_written: false,
        disk_preflight: { required_free_bytes: disk.required_free_bytes, available_bytes: disk.available_bytes },
        peak_memory: mem.peak,
        memory_breached: mem.breached,
        memory_failure: mem.failure,
        memory_samples: mem.samples,
        local_materialization_path: localPath,
        // Output limits (D-129 item 8): supplemental spike outputs ONLY.
        emitted_family_artifact: false,
        emitted_reader_package: false,
        emitted_f4_candidate: false,
        emitted_latest_update: false,
        emitted_public_api_route: false,
        emitted_family_registration: false,
    };
}

/**
 * The ratified-lock-gated full-corpus payload run. ALL of assertRatifiedLockGate +
 * disk preflight + memory-monitor start run BEFORE any client. Then reconcile the
 * two metadata manifests against the lock, GET the payload, verify compressed
 * sha256 BEFORE trust, stream-decode (uncompressed sha256 + row count) with NO
 * decompressed file. Returns the envelope/row-count-hash report only.
 */
export async function executeFullRunGated(opts = {}, deps) {
    const lock = assertRatifiedLockGate(opts.lockPath, opts); // fail-before-network
    const diskDir = opts.diskDir || os.tmpdir();
    const disk = requireDiskPreflight(diskDir, { compressedBytes: lock.payload_compressed_bytes }); // fail-before-network
    const mem = startMemoryMonitor(opts.memory || {});
    const terminateOnBreach = (where) => {
        if (mem.breached) { mem.stop(); FAIL(`memory ceiling breached ${where} - run TERMINATED (bounded failure: ${JSON.stringify(mem.failure)})`); }
    };
    try {
        terminateOnBreach('before network');
        const guarded = deps.instrument(deps.makeClient(), fullRunAllowlist(lock));
        const recon = await reconcileMetadata(guarded, deps, lock); // BEFORE any payload GET
        const head = await deps.headObject(guarded, deps.bucket, lock.payload_key);
        if ((head.size || 0) > MAX_TOTAL_BYTES) FAIL(`payload HEAD size ${head.size} > cap ${MAX_TOTAL_BYTES} - fail-closed BEFORE GET`);
        if (lock.payload_compressed_bytes != null && head.size != null && head.size !== lock.payload_compressed_bytes) {
            FAIL(`payload size != lock pin (HEAD ${head.size} != ${lock.payload_compressed_bytes}) - fail-closed BEFORE GET`);
        }
        const got = await deps.getObject(guarded, deps.bucket, lock.payload_key);
        if (got.size > MAX_TOTAL_BYTES) FAIL(`payload GET size ${got.size} > cap ${MAX_TOTAL_BYTES} - fail-closed`);
        const compSha = sha256(got.body);
        if (compSha !== lock.payload_sha256_compressed) FAIL(`payload compressed sha256 != lock pin: lock=${lock.payload_sha256_compressed} got=${compSha} - fail-closed, NOT trusted`);
        mem.sample();
        // materializeTag defaults to the snapshot id; a TEST-ONLY override isolates
        // the temp dir so parallel workers never collide on the same materialization.
        const localPath = atomicMaterialize(materializationDir(opts.materializeTag || lock.snapshot_id), lock.payload_filename || 'bioactivities.jsonl.gz', got.body, head.size);
        const decoded = await streamDecodeVerify(got.body, { monitor: mem }); // no decompressed file
        terminateOnBreach('during decode');
        if (decoded.sha256_uncompressed !== lock.payload_sha256_uncompressed) {
            FAIL(`payload uncompressed sha256 != lock pin (during decode): lock=${lock.payload_sha256_uncompressed} got=${decoded.sha256_uncompressed} - fail-closed`);
        }
        if (decoded.rows !== lock.expected_row_count) {
            FAIL(`payload row count != lock pin (during decode): lock=${lock.expected_row_count} got=${decoded.rows} - fail-closed`);
        }
        mem.sample();
        return buildReport({ lock, recon, guarded, got, decoded, disk, mem, localPath });
    } finally {
        mem.stop();
    }
}
