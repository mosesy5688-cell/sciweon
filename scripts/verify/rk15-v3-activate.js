/**
 * RK-15 V3-B — PRODUCTION activation of the EXACT audited V3-A candidate.
 *
 * Accepts ONLY the exact audited candidate (snapshot_id, object_prefix,
 * manifest_key, manifest_hash, candidate_payload_hash, v3a_run_id), re-validates
 * it by its OWN keys, warms the legacy serving paths (no purge-first), then
 * activates it with a SINGLE CAS of production snapshots/latest.json (If-Match)
 * to the EXACT candidate payload. NO rebuild / NO backfill. The V3-B guard
 * enforces exactly ONE PutObject, key==snapshots/latest.json, carrying If-Match.
 *
 * Usage (workflow_dispatch only):
 *   node rk15-v3-activate.js --object-prefix=<p> --snapshot-id=<id> \
 *        --manifest-hash=<h> --candidate-payload-hash=<h> --v3a-run-id=<id> \
 *        [--manifest-key=<k>]
 */

import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

import { makeR2Client } from '../factory/lib/r2-stage-bridge.js';
import {
    PROD_LATEST_KEY, instrumentActivateClient, getObjectOrNull, classifyError, summarizePutConditionals,
} from './rk15-v3-lib.js';
import {
    validateDescriptorShape, evalDescriptorMatch, evalCasActivation, evalNoUnconditionalPut,
} from './rk15-v3-eval.js';
import {
    revalidateCandidate, warmLegacyCache, casActivate, servingAcceptance, deriveActiveFromPointer,
} from './rk15-v3-activate-flow.js';

const EVIDENCE_FILE = 'rk15-v3b-evidence.json';

export function parseArgs(argv) {
    const out = {};
    const map = {
        'object-prefix': 'object_prefix', 'snapshot-id': 'snapshot_id',
        'manifest-key': 'manifest_key', 'manifest-hash': 'manifest_hash',
        'candidate-payload-hash': 'candidate_payload_hash', 'v3a-run-id': 'v3a_run_id',
    };
    for (const a of argv) {
        const m = /^--([a-z0-9-]+)=(.+)$/.exec(a);
        if (m && map[m[1]]) out[map[m[1]]] = m[2];
    }
    return out;
}

/** Build the descriptor; manifest_key defaults to the v2 compounds manifest under
 * the prefix when not supplied (it is re-derived from the seal during validation). */
function toDescriptor(args) {
    return {
        snapshot_id: args.snapshot_id,
        object_prefix: args.object_prefix,
        manifest_key: args.manifest_key || (args.object_prefix ? `${args.object_prefix}compounds/bucket-0000/manifest.json` : ''),
        manifest_hash: args.manifest_hash,
        candidate_payload_hash: args.candidate_payload_hash,
        v3a_run_id: args.v3a_run_id,
    };
}

/**
 * Run V3-B against a (real or mock) client. The instrumented client enforces the
 * one-conditional-latest-PUT guard. `fetchImpl`/`baseUrl` drive the live warm +
 * acceptance probes (mocked in unit tests). Returns the V3-B evidence pack.
 */
export async function runV3B({ client, bucket, descriptor, baseUrl, fetchImpl }) {
    const inst = instrumentActivateClient(client);
    const checks = {};

    checks.descriptor_shape = validateDescriptorShape(descriptor);
    if (!checks.descriptor_shape.pass) {
        return finalize({ inst, descriptor, checks, b_pass: false });
    }

    // (1) re-validate the EXACT audited candidate by its OWN keys (throws on drift).
    const rv = await revalidateCandidate({ client: inst, bucket, descriptor });
    checks.descriptor_match = evalDescriptorMatch({
        descriptor, candidatePayloadHash: rv.candidatePayloadHash,
        sealSnapshotId: rv.sealSnapshotId, sealManifestHash: rv.sealManifestHash,
    });

    // (5) warm the legacy serving paths BEFORE the swap (no purge-first).
    const legacyWarm = await warmLegacyCache({ baseUrl, fetchImpl });

    // (3) the ONE conditional latest PUT: CAS prod latest to the EXACT candidate payload.
    const cas = await casActivate({ client: inst, bucket, candidatePayload: rv.candidatePayload });

    // (2) ACTIVE derived from the pointer fact (post-swap re-read names this candidate).
    const activeProbe = await deriveActiveFromPointer({ client: inst, bucket, snapshotId: descriptor.snapshot_id, manifestHash: descriptor.manifest_hash });
    checks.cas_activation = evalCasActivation({
        casSucceeded: cas.casSucceeded, casError: cas.casError,
        latestAfter: activeProbe.latest, snapshotId: descriptor.snapshot_id, manifestHash: descriptor.manifest_hash,
    });

    // (6) post-swap serving acceptance probes (GET only; mocked in tests).
    const acceptance = await servingAcceptance({ baseUrl, fetchImpl });

    checks.exactly_one_latest_put = {
        pass: inst.latestPutCount === 1, action: 'exactly ONE conditional latest PUT (no rebuild/backfill)', latest_put_count: inst.latestPutCount,
    };
    checks.no_unconditional_put = evalNoUnconditionalPut(inst.sendLog);

    const b_pass = Object.values(checks).every(c => c.pass) && activeProbe.active;
    return finalize({
        inst, descriptor, checks, b_pass,
        extra: {
            target_prefix: descriptor.object_prefix, snapshot_id: descriptor.snapshot_id, manifest_hash: descriptor.manifest_hash,
            prod_latest_before: cas.before && { etag: cas.before.etag, sha256: cas.before.sha256 },
            prod_latest_after: cas.after && { etag: cas.after.etag, sha256: cas.after.sha256 },
            legacy_warm_set: legacyWarm, serving_acceptance: acceptance,
            active_state: activeProbe.active ? 'ACTIVE' : 'NOT_ACTIVE',
            rollback_policy_honored: cas.casSucceeded || (checks.cas_activation && !checks.cas_activation.pass),
        },
    });
}

function finalize({ inst, descriptor, checks, b_pass, extra = {} }) {
    return {
        harness: 'rk15-v3-activate', descriptor, ...extra,
        put_conditional_summary: summarizePutConditionals(inst.sendLog),
        latest_put_count: inst.latestPutCount, checks, b_pass,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const descriptor = toDescriptor(args);
    const bucket = process.env.R2_BUCKET;
    const client = makeR2Client();
    const baseUrl = process.env.RK15_WORKER_BASE_URL || null;
    const fetchImpl = baseUrl ? globalThis.fetch : null;

    const report = await runV3B({ client, bucket, descriptor, baseUrl, fetchImpl });
    const json = JSON.stringify(report, null, 2);
    writeFileSync(EVIDENCE_FILE, json);
    console.log(json);
    console.log(`\n=== RK-15 V3-B === ${report.b_pass ? 'PASS' : 'FAIL'} (activated ${descriptor.snapshot_id} -> ${report.active_state ?? 'NOT_ACTIVE'})`);
    process.exit(report.b_pass ? 0 : 1);
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
    main().catch(err => {
        console.error('[rk15-v3-activate] FATAL:', err);
        try { writeFileSync(EVIDENCE_FILE, JSON.stringify({ harness: 'rk15-v3-activate', fatal: true, error: classifyError(err), b_pass: false }, null, 2)); } catch { /* best-effort */ }
        process.exit(1);
    });
}
