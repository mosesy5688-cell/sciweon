/**
 * RK-16C FULL-CORPUS SPIKE — CLI CONTROL + METADATA-ONLY PREFLIGHT.
 *
 * Pure state-matrix selector + the wiring for BOTH founder-gated remote paths:
 *   - `--preflight --execute` (with a correct --manifest-key) -> metadata-only
 *     TWO-MANIFEST preflightManifest();
 *   - `--full-run --lock <path>` -> the D-129 ratified-lock-gated payload run
 *     (runFullRun). The gated payload executor is imported LAZILY inside runFullRun
 *     ONLY, so module-load and the dry-run / preflight / fixture paths never touch
 *     it. Generic `--execute` (no --full-run) stays REFUSED.
 * NO production read, NO creds in the BUILD phase; runPreflight reads ONLY the two
 * metadata objects (root seal + deterministic per-file manifest sibling) via the
 * injected/lazy deps, validates + reconciles them, extracts the bioactivities pins
 * from the per-file manifest files[] entry, and writes an explicitly UNRATIFIED
 * candidate lock (founder_approved:false, authorized_for_payload_read:false).
 */

import fs from 'fs';
import path from 'path';
import { preflightManifest, redact } from './r2-readonly-adapter.mjs';
import { manifestObjectKey } from './corpus-identity.mjs';
import { instrumentExactReadOnlyClient } from './exact-readonly-guard.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const RESULTS_DIR = path.join(HERE, '..', 'results');
const CANDIDATE_FILE = 'RK16C_FULLCORPUS_LOCK.candidate.json';
const FULLRUN_ENVELOPE_FILE = 'RK16C_D129_FULLRUN_ENVELOPE.json';

/**
 * PURE state-matrix selector. Maps parsed args -> exactly one action, decided
 * BEFORE any client/network. The full-run/payload path is never selectable.
 * @returns {{action:string, reason:string}}
 */
export function selectAction(args) {
    if (args.cleanup) return { action: 'cleanup', reason: 'cleanup requested' };
    // D-129: the ratified-lock-gated payload run is reachable ONLY with BOTH
    // --full-run AND --lock. Generic --execute (below) stays refused.
    if (args.fullRun) {
        if (!args.lockPath) return { action: 'fail-closed', reason: '--full-run requires --lock <path> (absent) -> fail-closed before any client' };
        return { action: 'full-run', reason: '--full-run --lock -> ratified-lock-gated payload run (fail-before-network on any pin mismatch)' };
    }
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
    // args.execute && !args.preflight && !args.fullRun (incl. generic --execute,
    // --execute --lock, --payload, any unknown bypass). The ONLY payload path is
    // --full-run --lock (handled above); generic --execute stays refused.
    return { action: 'execute-refused', reason: 'generic --execute (would-be full run / --lock / --payload without --full-run) is CLI-UNREACHABLE; use --preflight --execute (metadata-only) or --full-run --lock (ratified-lock-gated payload run)' };
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

/**
 * METADATA-ONLY two-manifest preflight (D-103 A1): calls preflightManifest (which
 * reads EXACTLY the two metadata objects — root seal + deterministic per-file
 * manifest sibling — validates + reconciles them, and assembles the candidate
 * lock), then stamps it UNRATIFIED and writes it. NEVER reads the payload, NEVER
 * marks the lock approved, NEVER runs the full run. THROWS (fail-closed) on any
 * validation/reconciliation failure (no partial/degraded candidate is written).
 * @param {object} deps FAKE in tests; REAL (lazy) by default.
 */
export async function runPreflight(args, deps) {
    const d = deps || (await buildRealPreflightDeps());
    const opts = { execute: true, snapshot: args.snapshot, manifestKey: args.manifestKey, expectedRows: args.expectedRows };
    const pf = await preflightManifest(opts, d);
    const candidate = {
        ...pf.candidate,
        status: 'UNRATIFIED',
        founder_approved: false,
        authorized_for_payload_read: false,
        generated_at: new Date().toISOString(),
        note: 'UNRATIFIED preflight candidate — NOT a usable lock; payload was NOT read; A1 sibling-derived per-file manifest (root seal does NOT cryptographically reference it); founder review + ratification required before any payload GET.',
    };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const candidatePath = path.join(RESULTS_DIR, CANDIDATE_FILE);
    fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2));
    console.log('\n===== RK-16C PREFLIGHT (METADATA-ONLY, A1 TWO-MANIFEST) — UNRATIFIED CANDIDATE =====');
    console.log(redact(JSON.stringify({
        status: candidate.status, founder_approved: candidate.founder_approved,
        authorized_for_payload_read: candidate.authorized_for_payload_read,
        trust_anchor_mode: candidate.trust_anchor_mode,
        root_directly_references_file_manifest: candidate.root_directly_references_file_manifest,
        snapshot_id: candidate.snapshot_id,
        root_manifest_key: candidate.root_manifest_key, file_manifest_key: candidate.file_manifest_key,
        payload_key: candidate.payload_key, payload_compressed_bytes: candidate.payload_compressed_bytes,
        payload_sha256_compressed: candidate.payload_sha256_compressed, expected_row_count: candidate.expected_row_count,
        list_attempts: pf.list_attempt_count, non_allowlisted_attempts: pf.non_allowlisted_key_attempt_count,
    }, null, 2)));
    console.log(`[rk16c-fullcorpus] candidate written: ${candidatePath} (status=UNRATIFIED, NOT approved, payload NOT read)`);
    return { candidate, candidatePath };
}

/**
 * Build the REAL deps for the gated payload run LAZILY (same as the preflight deps:
 * the exact-readonly guard + the read-only HEAD/GET primitives). Tests inject FAKE
 * deps instead; module-load never needs credentials / the SDK.
 */
async function buildRealFullRunDeps() {
    const { makeR2Client } = await import('../../../factory/lib/r2-stage-bridge.js');
    const { headObject, getObject } = await import('../../../verify/p8-r1-readonly-probe-lib.js');
    return {
        makeClient: makeR2Client,
        instrument: instrumentExactReadOnlyClient,
        headObject, getObject,
        bucket: process.env.R2_BUCKET,
    };
}

/**
 * DISPATCH the `full-run` action to the ratified-lock-gated payload executor. The
 * gated executor is imported LAZILY here (never at module-load) so the dry-run /
 * preflight / fixture paths never load it. It FAILS BEFORE NETWORK on any pin
 * mismatch or without an explicit payload-read grant; on success it writes ONLY the
 * supplemental envelope / row-count-hash report (never a family/reader/F4 artifact).
 * @param {object} deps FAKE in tests; REAL (lazy) by default.
 */
export async function runFullRun(args, deps) {
    const { executeFullRunGated } = await import('./fullcorpus-run-gate.mjs');
    const d = deps || (await buildRealFullRunDeps());
    const opts = {
        lockPath: args.lockPath,
        authorizedForPayloadRead: args.authorizedForPayloadRead === true,
        memory: args.memory,
        buildCommit: args.buildCommit || null,
    };
    const report = await executeFullRunGated(opts, d);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = path.join(RESULTS_DIR, FULLRUN_ENVELOPE_FILE);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log('\n===== RK-16C FULL-CORPUS PAYLOAD RUN (D-129 wiring; ratified-lock-gated) =====');
    console.log(redact(JSON.stringify({
        output_kind: report.output_kind, network_performed: report.network_performed,
        rows_decoded: report.rows_decoded, payload_compressed_bytes: report.payload_compressed_bytes,
        payload_uncompressed_bytes: report.payload_uncompressed_bytes,
        peak_memory: report.peak_memory, memory_breached: report.memory_breached,
        decompressed_file_written: report.decompressed_file_written,
        emitted_family_artifact: report.emitted_family_artifact,
    }, null, 2)));
    console.log(`[rk16c-fullcorpus] envelope written: ${outPath} (supplemental spike output only)`);
    return { report, outPath };
}
