/**
 * RK-16C FULL-CORPUS SPIKE — CLI CONTROL + METADATA-ONLY PREFLIGHT.
 *
 * Pure state-matrix selector + the wiring that lets ONLY `--preflight --execute`
 * (with a correct --manifest-key) reach the metadata-only preflightManifest().
 * The full-run/payload path is CLI-UNREACHABLE: it is never selectable and the
 * full-run adapter symbol is NOT imported here. NO production read, NO creds in
 * the BUILD phase; runPreflight reads ONLY the manifest (via the injected/lazy
 * deps), extracts payload pins FROM the manifest body, and writes an explicitly
 * UNRATIFIED candidate lock (founder_approved:false, authorized_for_payload_read:false).
 */

import fs from 'fs';
import path from 'path';
import { preflightManifest, redact } from './r2-readonly-adapter.mjs';
import { manifestObjectKey, bioactivitiesObjectKey } from './corpus-identity.mjs';
import { instrumentExactReadOnlyClient } from './exact-readonly-guard.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const RESULTS_DIR = path.join(HERE, '..', 'results');
const CANDIDATE_FILE = 'RK16C_FULLCORPUS_LOCK.candidate.json';

/**
 * PURE state-matrix selector. Maps parsed args -> exactly one action, decided
 * BEFORE any client/network. The full-run/payload path is never selectable.
 * @returns {{action:string, reason:string}}
 */
export function selectAction(args) {
    if (args.cleanup) return { action: 'cleanup', reason: 'cleanup requested' };
    if (!args.execute && !args.preflight) {
        return { action: 'dry-run-matrix', reason: 'no flags -> BUILD fixture matrix (zero network)' };
    }
    if (args.preflight && !args.execute) {
        return { action: 'preflight-plan', reason: '--preflight without --execute -> dry-run plan only (zero network, no matrix)' };
    }
    if (args.preflight && args.execute) {
        if (!args.manifestKey) {
            return { action: 'fail-closed', reason: '--preflight --execute requires --manifest-key (absent) -> fail-closed before any client' };
        }
        if (!args.snapshot || args.manifestKey !== manifestObjectKey(args.snapshot)) {
            return { action: 'fail-closed', reason: `--manifest-key does not equal the exact manifest key for --snapshot (${manifestObjectKey(args.snapshot)}) -> fail-closed before any client` };
        }
        return { action: 'preflight-execute', reason: '--preflight --execute with exact --manifest-key -> metadata-only preflightManifest' };
    }
    // args.execute && !args.preflight (incl. --execute --lock, --full-run, --payload, any unknown bypass).
    return { action: 'execute-refused', reason: 'generic --execute (would-be full run / --lock / --full-run / --payload) is CLI-UNREACHABLE; only --preflight --execute is permitted' };
}

/**
 * Build the REAL deps for preflightManifest LAZILY (so module-load + tests never
 * need credentials / the SDK). Tests inject a FAKE deps instead.
 */
async function buildRealPreflightDeps() {
    const { makeR2Client } = await import('../../../factory/lib/r2-stage-bridge.js');
    const { headObject, getObject } = await import('../../../verify/p8-r1-readonly-probe-lib.js');
    return {
        makeClient: makeR2Client,
        instrument: instrumentExactReadOnlyClient,
        headObject, getObject,
        bucket: process.env.R2_BUCKET,
    };
}

/** Parse the snapshot-builder manifest body and pull the bioactivities pins. */
export function extractPayloadPins(manifestBody, payloadKey) {
    const text = Buffer.isBuffer(manifestBody) ? manifestBody.toString('utf-8') : String(manifestBody);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(`[rk16c-fullcorpus] manifest body is not valid JSON — no approvable lock: ${e?.message ?? e}`); }
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    const wantName = payloadKey.split('/').pop(); // bioactivities.jsonl.gz
    const entry = files.find((f) => f && (f.filename === wantName || f.filename === payloadKey || f.key === payloadKey));
    if (!entry) {
        throw new Error(`[rk16c-fullcorpus] manifest body has no '${wantName}' file entry — no approvable lock (refusing to fabricate payload pins)`);
    }
    if (entry.sha256_compressed == null || entry.compressed_bytes == null) {
        throw new Error(`[rk16c-fullcorpus] '${wantName}' entry lacks sha256_compressed/compressed_bytes — no approvable lock`);
    }
    return {
        sha256_compressed: entry.sha256_compressed,
        compressed_bytes: entry.compressed_bytes,
        records: entry.records != null ? entry.records : null,
    };
}

/**
 * METADATA-ONLY preflight: calls preflightManifest (manifest key only), extracts
 * payload pins FROM the manifest body, and writes an UNRATIFIED candidate lock.
 * NEVER reads the payload, NEVER marks the lock approved, NEVER runs the full
 * run. THROWS if the manifest body lacks the bioactivities entry/pins.
 * @param {object} deps FAKE in tests; REAL (lazy) by default.
 */
export async function runPreflight(args, deps) {
    const d = deps || (await buildRealPreflightDeps());
    const opts = { execute: true, snapshot: args.snapshot, manifestKey: args.manifestKey };
    const pf = await preflightManifest(opts, d);
    const payloadKey = bioactivitiesObjectKey(args.snapshot);
    const payload = extractPayloadPins(pf.manifest_body, payloadKey);
    const candidate = {
        schema_version: 'rk16c-fullcorpus-lock-v1',
        status: 'UNRATIFIED',
        founder_approved: false,
        authorized_for_payload_read: false,
        snapshot_id: args.snapshot,
        production_run_id: args.snapshot.split('/')[1] || null,
        manifest_key: pf.manifest_key,
        manifest_etag: pf.manifest_etag,
        manifest_byte_size: pf.manifest_byte_size,
        manifest_sha256: pf.manifest_sha256,
        payload_key: payloadKey,
        payload_byte_size: payload.compressed_bytes,
        payload_sha256: payload.sha256_compressed,
        expected_row_count: payload.records != null ? payload.records : args.expectedRows,
        generated_at: new Date().toISOString(),
        note: 'UNRATIFIED preflight candidate — NOT a usable lock; payload was NOT read; founder review + ratification required before any payload GET.',
    };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const candidatePath = path.join(RESULTS_DIR, CANDIDATE_FILE);
    fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2));
    console.log('\n===== RK-16C PREFLIGHT (METADATA-ONLY) — UNRATIFIED CANDIDATE =====');
    console.log(redact(JSON.stringify({
        status: candidate.status, founder_approved: candidate.founder_approved,
        authorized_for_payload_read: candidate.authorized_for_payload_read,
        snapshot_id: candidate.snapshot_id, manifest_key: candidate.manifest_key,
        payload_key: candidate.payload_key, payload_byte_size: candidate.payload_byte_size,
        payload_sha256: candidate.payload_sha256, expected_row_count: candidate.expected_row_count,
        list_attempts: pf.list_attempt_count, non_allowlisted_attempts: pf.non_allowlisted_key_attempt_count,
    }, null, 2)));
    console.log(`[rk16c-fullcorpus] candidate written: ${candidatePath} (status=UNRATIFIED, NOT approved, payload NOT read)`);
    return { candidate, candidatePath };
}
