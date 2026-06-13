/**
 * RK-15 V3 — shared PURE logic + production-namespace candidate primitives +
 * the TWO V3 write-GUARDs and the V3-A/V3-B descriptor shape.
 *
 * V3 is the PRODUCTION cutover, done in two SEPARATE founder-authorized gates:
 *   V3-A (rk15-v3-candidate.js)  builds an IMMUTABLE candidate in the PRODUCTION
 *        namespace (snapshots/<date>/<runId>-<attempt>/) WITHOUT swapping
 *        production latest. Max state: VALIDATED / ACTIVATABLE / NOT ACTIVE.
 *   V3-B (rk15-v3-activate.js)   activates ONLY that exact audited candidate by
 *        a single CAS swap of production snapshots/latest.json.
 *
 * Two structural pre-send write-GUARDs (mirroring V2's assertIsolatedKey):
 *   V3-A guard: a PutObject is ALLOWED only under the candidate prefix; ANY
 *               write to snapshots/latest.json, any OTHER snapshot prefix, or
 *               under processed/** / aggregated/** / rk15-verification/** is a
 *               HARD CONTRACT VIOLATION (a production-latest write would be a
 *               production cutover the candidate gate must NOT perform).
 *   V3-B guard: exactly ONE PutObject, key == snapshots/latest.json, carrying
 *               If-Match; ANY other key / a 2nd PUT / a latest PUT WITHOUT
 *               If-Match is a HARD FAIL.
 *
 * NOTHING here re-implements a producer path: the publish/seal/validate/CAS
 * primitives are imported from the producer libs. This file holds only the
 * harness control logic + guards + the cross-script descriptor contract.
 */

import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { isPreconditionFailed, isConditionalUnsupported } from '../factory/lib/snapshot-identity.js';

export const PROD_LATEST_KEY = 'snapshots/latest.json';
// The fixed Run #1 aggregated source — bound DIRECTLY (NOT via any latest.json
// pointer / the current date / the latest run).
export const FIXED_SOURCE_RUN_ID = '27413864028';
export const FIXED_SOURCE_PREFIX = `processed/aggregated/${FIXED_SOURCE_RUN_ID}/`;
// Source prefixes that V3-A must NEVER write (it reads the source GET/HEAD only).
const FORBIDDEN_WRITE_PREFIXES = ['processed/', 'aggregated/', 'rk15-verification/'];

export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

export function lineCount(buf) {
    if (!buf || buf.length === 0) return 0;
    const text = buf.toString('utf-8');
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (trimmed.length === 0) return 0;
    return trimmed.split('\n').length;
}

export async function streamToBuffer(body) {
    if (body == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    const chunks = [];
    for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
}

export function classifyError(err) {
    if (!err) return { name: null, httpStatus: null, message: null };
    return {
        name: err.name ?? null,
        httpStatus: err.$metadata?.httpStatusCode ?? null,
        message: err.message ?? String(err),
        preconditionFailed: isPreconditionFailed(err),
        conditionalUnsupported: isConditionalUnsupported(err),
    };
}

// ── V3-A candidate write-GUARD ───────────────────────────────────────────────

/**
 * The V3-A CANDIDATE-PREFIX GUARD. A write is ALLOWED only when its key is
 * strictly under `candidatePrefix`. Production latest, any OTHER snapshot
 * prefix, and the source/aggregated/verification prefixes are HARD-FAILED. This
 * is the structural seam that makes a production-latest write IMPOSSIBLE in V3-A.
 */
export function assertCandidateKey(key, candidatePrefix) {
    if (typeof key !== 'string') {
        throw new Error(`[RK15-V3A GUARD] refusing a write with a non-string key: ${JSON.stringify(key)}`);
    }
    if (key === PROD_LATEST_KEY) {
        throw new Error(`[RK15-V3A GUARD] refusing a write to PRODUCTION latest (${PROD_LATEST_KEY}) — V3-A must NOT swap production latest`);
    }
    for (const p of FORBIDDEN_WRITE_PREFIXES) {
        if (key.startsWith(p)) {
            throw new Error(`[RK15-V3A GUARD] refusing a write under a read-only/forbidden prefix ${JSON.stringify(p)}: ${JSON.stringify(key)}`);
        }
    }
    if (!key.startsWith(candidatePrefix)) {
        throw new Error(`[RK15-V3A GUARD] refusing a write outside the candidate prefix: ${JSON.stringify(key)} (must start with ${candidatePrefix})`);
    }
}

/**
 * Wrap `client.send` for V3-A: EVERY PutObject key is run through
 * assertCandidateKey BEFORE it reaches R2 (an escaping write throws here, never
 * hitting the store); GET/HEAD are read-only and unguarded (the source + the
 * production-latest invariance read are intentional). Each PUT's conditional
 * header is recorded for the no-unconditional audit.
 */
export function instrumentCandidateClient(realClient, candidatePrefix) {
    const log = [];
    return {
        sendLog: log,
        candidatePrefix,
        get callCount() { return log.length; },
        async send(command, ...rest) {
            const ctorName = command?.constructor?.name ?? 'UnknownCommand';
            const input = command?.input ?? {};
            const entry = { seq: log.length + 1, command: ctorName, key: input.Key ?? null };
            if (ctorName === 'PutObjectCommand') {
                assertCandidateKey(input.Key, candidatePrefix); // GUARD: prod-latest write impossible.
                entry.put = {
                    ifNoneMatch: input.IfNoneMatch ?? null,
                    ifMatch: input.IfMatch ?? null,
                    conditional: input.IfNoneMatch != null || input.IfMatch != null,
                };
            }
            log.push(entry);
            try {
                const res = await realClient.send(command, ...rest);
                entry.ok = true;
                return res;
            } catch (err) {
                entry.ok = false;
                entry.errorName = err?.name ?? null;
                entry.httpStatus = err?.$metadata?.httpStatusCode ?? null;
                throw err;
            }
        },
    };
}

// ── V3-B activation write-GUARD ──────────────────────────────────────────────

/**
 * The V3-B ACTIVATION GUARD. The ONLY permitted write is the ONE production
 * latest CAS: key == snapshots/latest.json, carrying If-Match. ANY other key, a
 * second PUT, or a latest PUT WITHOUT If-Match is a HARD FAIL (no rebuild, no
 * backfill, no unconditional latest write). State is tracked on the wrapper.
 */
export function instrumentActivateClient(realClient) {
    const log = [];
    const state = { latestPutCount: 0 };
    return {
        sendLog: log,
        get callCount() { return log.length; },
        get latestPutCount() { return state.latestPutCount; },
        async send(command, ...rest) {
            const ctorName = command?.constructor?.name ?? 'UnknownCommand';
            const input = command?.input ?? {};
            const entry = { seq: log.length + 1, command: ctorName, key: input.Key ?? null };
            if (ctorName === 'PutObjectCommand') {
                const hasIfMatch = input.IfMatch != null;
                if (input.Key !== PROD_LATEST_KEY) {
                    throw new Error(`[RK15-V3B GUARD] refusing a non-latest write: ${JSON.stringify(input.Key)} — V3-B may write ONLY ${PROD_LATEST_KEY} (no rebuild/backfill)`);
                }
                if (!hasIfMatch) {
                    throw new Error(`[RK15-V3B GUARD] refusing a latest write WITHOUT If-Match — activation MUST be a CAS (no unconditional latest PUT)`);
                }
                if (state.latestPutCount >= 1) {
                    throw new Error('[RK15-V3B GUARD] refusing a SECOND latest write — activation is exactly ONE conditional PUT');
                }
                state.latestPutCount += 1;
                entry.put = { ifMatch: input.IfMatch, conditional: true };
            }
            log.push(entry);
            try {
                const res = await realClient.send(command, ...rest);
                entry.ok = true;
                return res;
            } catch (err) {
                entry.ok = false;
                entry.errorName = err?.name ?? null;
                entry.httpStatus = err?.$metadata?.httpStatusCode ?? null;
                throw err;
            }
        },
    };
}

// ── PUT-conditional audits (shared) ──────────────────────────────────────────

export function summarizePutConditionals(sendLog) {
    const puts = sendLog.filter(e => e.command === 'PutObjectCommand');
    const unconditional = puts.filter(e => e.put && e.put.conditional === false);
    return {
        putCount: puts.length,
        conditionalPutCount: puts.filter(e => e.put && e.put.conditional).length,
        unconditionalPutCount: unconditional.length,
        unconditionalKeys: unconditional.map(e => e.key),
        writtenKeys: puts.map(e => e.key),
    };
}

// ── read-only R2 primitives (source + production latest are GET/HEAD only) ────

export async function getObject(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(res.Body);
    return { etag: res.ETag ?? null, body, sha256: sha256Hex(body) };
}

export async function headObject(client, bucket, key) {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { etag: res.ETag ?? null, size: res.ContentLength ?? res.Size ?? 0 };
}

export async function getObjectOrNull(client, bucket, key) {
    try { return await getObject(client, bucket, key); }
    catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}
