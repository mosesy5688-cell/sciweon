/**
 * RK-15 V1 verify — shared PURE logic + R2 primitive ops.
 *
 * Extracted from rk15-v1-verify.js to keep each file under the 250-line monolith
 * cap and to make the evaluation logic unit-testable with a mock client. NO file
 * here ever writes to production snapshots/latest.json (it is GET-only).
 */

import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
    isPreconditionFailed,
    isConditionalUnsupported,
} from '../factory/lib/snapshot-identity.js';

export const PROD_LATEST_KEY = 'snapshots/latest.json';
export const EVIDENCE_FILE = 'rk15-v1-evidence.json';

export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

export async function streamToBuffer(body) {
    if (body == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    const chunks = [];
    for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
}

/**
 * True if `err` is a create-only collision. `putCreateOnly` (the production path)
 * re-throws the SDK 412 wrapped in a NEW Error whose message is
 * "[CREATE-ONLY] object already exists, refusing to overwrite: ..." — that message
 * no longer contains "precondition", so `isPreconditionFailed` alone misses it.
 * We recognize BOTH the raw 412 AND the production wrapper here.
 */
export function isCreateOnlyCollision(err) {
    return isPreconditionFailed(err)
        || /\[CREATE-ONLY\] object already exists/i.test(err?.message ?? '');
}

/** Classify an SDK error into a small, evidence-friendly shape. */
export function classifyError(err) {
    if (!err) return { name: null, httpStatus: null, message: null };
    return {
        name: err.name ?? null,
        httpStatus: err.$metadata?.httpStatusCode ?? null,
        message: err.message ?? String(err),
        preconditionFailed: isPreconditionFailed(err),
        createOnlyCollision: isCreateOnlyCollision(err),
        conditionalUnsupported: isConditionalUnsupported(err),
    };
}

/**
 * Wrap `client.send` so EVERY command is recorded. For PutObjectCommand we
 * capture whether it carried IfNoneMatch / IfMatch. The returned object exposes
 * the wrapped client plus the live send-log + a counter. putCreateOnly /
 * swapLatestPointer only call `.send`, so they get instrumented transparently.
 */
export function instrumentClient(realClient) {
    const log = [];
    return {
        sendLog: log,
        get callCount() { return log.length; },
        async send(command, ...rest) {
            const ctorName = command?.constructor?.name ?? 'UnknownCommand';
            const input = command?.input ?? {};
            const entry = { seq: log.length + 1, command: ctorName, key: input.Key ?? null };
            if (ctorName === 'PutObjectCommand') {
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

/** From a send-log, summarize PutObject conditional coverage. */
export function summarizePutConditionals(sendLog) {
    const puts = sendLog.filter(e => e.command === 'PutObjectCommand');
    const unconditional = puts.filter(e => e.put && e.put.conditional === false);
    return {
        putCount: puts.length,
        conditionalPutCount: puts.filter(e => e.put && e.put.conditional).length,
        unconditionalPutCount: unconditional.length,
        unconditionalKeys: unconditional.map(e => e.key),
        ifNoneMatchCount: puts.filter(e => e.put && e.put.ifNoneMatch != null).length,
        ifMatchCount: puts.filter(e => e.put && e.put.ifMatch != null).length,
    };
}

// ── primitive R2 ops (always namespaced; production latest.json is GET-only) ──

export async function getObject(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(res.Body);
    return { etag: res.ETag ?? null, body, sha256: sha256Hex(body) };
}

export async function headEtag(client, bucket, key) {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return res.ETag ?? null;
}

/** GET an object that may be absent; returns null on 404/NoSuchKey. */
export async function getObjectOrNull(client, bucket, key) {
    try {
        return await getObject(client, bucket, key);
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

// ── pure check evaluators (control logic, unit-tested via the harness) ───────

/**
 * Evaluate the create-only collision check (Step 3). Pure: given the second-PUT
 * outcome + the read-back object, returns a `{ pass, ... }` check object.
 *   secondPutSucceeded — the collision PUT did NOT throw (non-enforcement!)
 *   err                — the thrown error (if any)
 *   afterGet           — read-back { etag, sha256 } (or { error })
 *   step2 / key        — the original object identity + key
 */
export function evalCreateOnlyCollision({ key, secondPutSucceeded, err, afterGet, step2Etag, step2Sha }) {
    const action = `putCreateOnly (collision) ${key}`;
    const unchanged = afterGet && afterGet.sha256 === step2Sha && afterGet.etag === step2Etag;
    if (secondPutSucceeded) {
        return {
            pass: false, action,
            reason: 'SECOND create-only PUT SUCCEEDED -> R2 did NOT enforce IfNoneMatch:* (silent overwrite risk)',
            objectUnchanged: !!unchanged,
            afterEtag: afterGet?.etag ?? null, afterSha256: afterGet?.sha256 ?? null, step2Etag, step2Sha256: step2Sha,
        };
    }
    const cls = classifyError(err);
    if (cls.conditionalUnsupported && !cls.createOnlyCollision) {
        return { pass: false, action, reason: 'R2 REJECTED the conditional header (400/501) -> create-only cannot be relied upon', error: cls, objectUnchanged: !!unchanged };
    }
    if (!cls.createOnlyCollision) {
        return { pass: false, action, reason: 'collision raised a NON-precondition error', error: cls, objectUnchanged: !!unchanged };
    }
    if (!unchanged) {
        return { pass: false, action, reason: 'precondition failed BUT object bytes changed (control violated)', error: cls, afterEtag: afterGet?.etag ?? null, afterSha256: afterGet?.sha256 ?? null, step2Etag, step2Sha256: step2Sha };
    }
    return { pass: true, action, error: cls, objectUnchanged: true, etag: afterGet.etag, sha256: afterGet.sha256 };
}

/**
 * Evaluate the wrong-ETag CAS rejection check (Step 5). Pure: given the CAS
 * outcome + read-back, returns a `{ pass, ... }` check object.
 */
export function evalCasWrongEtag({ key, casSucceeded, err, afterGet, step4Etag, step4Sha }) {
    const action = `CAS PUT (IfMatch WRONG) ${key}`;
    const unchanged = afterGet && afterGet.sha256 === step4Sha && afterGet.etag === step4Etag;
    if (casSucceeded) {
        return {
            pass: false, action, reason: 'wrong-ETag CAS SUCCEEDED -> R2 did NOT enforce If-Match',
            objectUnchanged: !!unchanged,
            afterEtag: afterGet?.etag ?? null, afterSha256: afterGet?.sha256 ?? null, step4Etag, step4Sha256: step4Sha,
        };
    }
    const cls = classifyError(err);
    if (cls.conditionalUnsupported && !cls.preconditionFailed) {
        return { pass: false, action, reason: 'R2 REJECTED the If-Match header (400/501) -> CAS cannot be relied upon', error: cls, objectUnchanged: !!unchanged };
    }
    if (!cls.preconditionFailed) {
        return { pass: false, action, reason: 'wrong-ETag CAS raised a NON-precondition error', error: cls, objectUnchanged: !!unchanged };
    }
    if (!unchanged) {
        return { pass: false, action, reason: 'precondition failed BUT object bytes changed (control violated)', error: cls, afterEtag: afterGet?.etag ?? null, afterSha256: afterGet?.sha256 ?? null, step4Etag, step4Sha256: step4Sha };
    }
    return { pass: true, action, error: cls, objectUnchanged: true, etag: afterGet.etag, sha256: afterGet.sha256 };
}

/** Evaluate the no-unconditional-PUT audit (Step 6) from a put-conditional summary. */
export function evalNoUnconditionalPut(summary) {
    if (summary.unconditionalPutCount === 0 && summary.putCount > 0) {
        return { pass: true, action: 'send-log audit', ...summary };
    }
    if (summary.putCount === 0) {
        return { pass: false, action: 'send-log audit', reason: 'no PutObjectCommand was issued at all (harness did not exercise writes)', ...summary };
    }
    return {
        pass: false, action: 'send-log audit',
        reason: `${summary.unconditionalPutCount} unconditional PUT(s) issued -> a wrapper degraded to an unconditional write`,
        ...summary,
    };
}

/** Evaluate production-latest before/after invariance (Step 7). */
export function evalProdLatestInvariance(prodBefore, prodAfter) {
    const action = `GET ${PROD_LATEST_KEY} (read-only)`;
    const beforePresent = prodBefore != null, afterPresent = prodAfter != null;
    const identical = beforePresent === afterPresent
        && (prodBefore?.etag ?? null) === (prodAfter?.etag ?? null)
        && (prodBefore?.sha256 ?? null) === (prodAfter?.sha256 ?? null);
    if (identical) {
        return { pass: true, action, present: afterPresent, etag: prodAfter?.etag ?? null, sha256: prodAfter?.sha256 ?? null };
    }
    return {
        pass: false, action, reason: 'production latest.json CHANGED between before/after',
        before: { present: beforePresent, etag: prodBefore?.etag ?? null, sha256: prodBefore?.sha256 ?? null },
        after: { present: afterPresent, etag: prodAfter?.etag ?? null, sha256: prodAfter?.sha256 ?? null },
    };
}

// ── human-readable summary ───────────────────────────────────────────────────

export function printHumanSummary(report) {
    const lines = [];
    lines.push('=== RK-15 V1 verification ===');
    lines.push(`run_id:     ${report.run_id}`);
    lines.push(`commit_sha: ${report.commit_sha ?? '(none)'}`);
    lines.push(`namespace:  ${report.namespace}`);
    lines.push(`PUT audit:  ${report.put_conditional_summary.putCount} PUT(s), ` +
        `${report.put_conditional_summary.conditionalPutCount} conditional, ` +
        `${report.put_conditional_summary.unconditionalPutCount} unconditional`);
    lines.push('checks:');
    for (const [name, c] of Object.entries(report.checks)) {
        lines.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${name}${c.reason ? ` - ${c.reason}` : ''}`);
    }
    lines.push(`OVERALL: ${report.v1_pass ? 'v1_pass=TRUE' : 'v1_pass=FALSE'}`);
    return lines.join('\n');
}
