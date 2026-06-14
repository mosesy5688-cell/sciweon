/**
 * RK-15 V3-C — shared PURE logic for the STRICT READ-ONLY serving-acceptance
 * harness: the read-only WRITE-GUARD, the candidate binding (latest == INPUT),
 * the source/candidate/live three-layer parity rules, the stability evaluator,
 * and the small read helpers — split out to stay under the CES 250-line cap and
 * be unit-testable with a mock client + fetch.
 *
 * READ-ONLY CONTRACT: ONLY R2 GET/HEAD + HTTP GET. NO PutObject / write / latest
 * change / cache purge. instrumentReadOnlyClient HARD-FAILS the instant a write
 * command is constructed and records put_count (which MUST be 0).
 */

import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { parseSnapshotContext } from '../../src/worker/lib/snapshot-context.ts';

// The fixed Run #1 aggregated source — bound DIRECTLY (NOT via latest.json).
export const SOURCE_RUN_ID = '27413864028';
export const SOURCE_COMPOUNDS_KEY = `processed/aggregated/${SOURCE_RUN_ID}/compounds-enriched.jsonl`;
export const PROD_LATEST_KEY = 'snapshots/latest.json'; // read-only GET only.

// The candidate is NO LONGER hardcoded: it is bound from the RUN INPUT
// (candidate_snapshot_id) and ASSERTED == production latest at runtime
// (bindCandidate); the candidate prefix derives from the INPUT id.
export function candidatePrefix(candidateSnapshotId) {
    return `snapshots/${candidateSnapshotId}/`;
}

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

// ── the READ-ONLY write-GUARD ────────────────────────────────────────────────

/**
 * Wrap `client.send` so EVERY command is inspected BEFORE it reaches R2. A
 * write/copy/delete command is a HARD CONTRACT VIOLATION and throws here, never
 * hitting the store; only Get/HeadObjectCommand pass. putCount MUST remain 0.
 */
const WRITE_COMMANDS = new Set([
    'PutObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand',
    'CopyObjectCommand', 'CreateMultipartUploadCommand', 'UploadPartCommand',
    'CompleteMultipartUploadCommand', 'PutBucketLifecycleConfigurationCommand',
]);

export function instrumentReadOnlyClient(realClient) {
    const log = [];
    const state = { putCount: 0 };
    return {
        sendLog: log,
        get callCount() { return log.length; },
        get putCount() { return state.putCount; },
        async send(command, ...rest) {
            const ctorName = command?.constructor?.name ?? 'UnknownCommand';
            if (ctorName === 'PutObjectCommand' || WRITE_COMMANDS.has(ctorName)) {
                state.putCount += 1; // count BEFORE throwing so the audit sees it.
                throw new Error(`[RK15-V3C READ-ONLY GUARD] refusing a WRITE command (${ctorName}) — V3-C is strictly read-only (R2 GET/HEAD only): no PutObject / no latest change / no cache purge`);
            }
            if (ctorName !== 'GetObjectCommand' && ctorName !== 'HeadObjectCommand') {
                throw new Error(`[RK15-V3C READ-ONLY GUARD] refusing a non-read command (${ctorName}) — only GetObjectCommand / HeadObjectCommand are permitted`);
            }
            const entry = { seq: log.length + 1, command: ctorName, key: command?.input?.Key ?? null };
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

/** put_count is the number of write commands the guard ever SAW (must be 0). */
export function putCount(client) {
    return client?.putCount ?? 0;
}

// ── read-only R2 primitives (source + candidate are GET/HEAD only) ───────────

export async function getObject(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(res.Body);
    return { etag: res.ETag ?? null, body, sha256: sha256Hex(body) };
}

export async function getObjectRange(client, bucket, key, offset, size) {
    const Range = `bytes=${offset}-${offset + size - 1}`;
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range }));
    return await streamToBuffer(res.Body);
}

export async function headObject(client, bucket, key) {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { etag: res.ETag ?? null, size: res.ContentLength ?? res.Size ?? 0 };
}

export async function getObjectOrNull(client, bucket, key) {
    try { return await getObject(client, bucket, key); }
    catch (err) {
        if (err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

// ── candidate binding (the core: latest == INPUT candidate, no derive-accept) ─

/**
 * Bind the candidate to the RUN INPUT, then ASSERT production latest points at
 * EXACTLY it (NOT derive-and-accept — INPUT is truth; latest elsewhere = HARD
 * FAIL). Read latest.json ONCE (GET); parse via parseSnapshotContext (legacy_v1
 * -> fail); assert snapshot_id == input, sha256(latest bytes) == input hash, and
 * (if given) manifest_hash == input. Missing required input -> HARD FAIL.
 */
export async function bindCandidate(client, bucket, input) {
    const id = (input?.candidate_snapshot_id ?? '').trim();
    const payloadHash = (input?.candidate_payload_hash ?? '').trim();
    const wantManifestHash = (input?.manifest_hash ?? '').trim() || null;
    const fail = (reason, extra = {}) => ({ check: { pass: false, reason, candidate_snapshot_id: id || null, ...extra }, ctx: null, candidatePrefix: null });

    if (!id || !payloadHash) {
        return fail('missing required run input — candidate_snapshot_id AND candidate_payload_hash are REQUIRED (missing required input is a HARD FAIL, never a silent skip)', { candidate_payload_hash_present: payloadHash.length > 0 });
    }
    // 1) read production latest.json ONCE.
    let body, sha;
    try { const g = await getObject(client, bucket, PROD_LATEST_KEY); body = g.body; sha = g.sha256; }
    catch (err) { return fail(`could not read production ${PROD_LATEST_KEY}: ${String(err?.message ?? err)}`); }
    // 2) parse via the reader's own parser (legacy_v1 -> hard fail below).
    let ctx;
    try { ctx = parseSnapshotContext(body.toString('utf-8')); }
    catch (err) { return fail(`production latest.json is not a parseable snapshot context: ${String(err?.message ?? err)}`, { latest_payload_sha256: sha }); }

    const isV2 = ctx.layout_version === 'immutable_snapshot_v2';
    const idMatch = ctx.snapshot_id === id;
    const hashMatch = sha === payloadHash;
    const mhMatch = wantManifestHash == null ? true : ctx.manifest_hash === wantManifestHash;
    const pass = isV2 && idMatch && hashMatch && mhMatch;
    const reasons = [];
    if (!isV2) reasons.push(`latest layout_version=${JSON.stringify(ctx.layout_version)} not immutable_snapshot_v2 — cannot match a v2 candidate`);
    if (!idMatch) reasons.push(`latest.snapshot_id=${JSON.stringify(ctx.snapshot_id)} != input=${JSON.stringify(id)} — HARD FAIL (no derive-and-accept)`);
    if (!hashMatch) reasons.push(`sha256(latest.json)=${sha} != input hash=${payloadHash} — HARD FAIL`);
    if (!mhMatch) reasons.push(`latest.manifest_hash=${JSON.stringify(ctx.manifest_hash)} != input=${JSON.stringify(wantManifestHash)} — HARD FAIL`);

    return {
        check: {
            pass, candidate_snapshot_id: id, latest_snapshot_id: ctx.snapshot_id,
            latest_layout_version: ctx.layout_version, latest_payload_sha256: sha,
            candidate_payload_hash: payloadHash, manifest_hash_input: wantManifestHash,
            manifest_hash_observed: ctx.manifest_hash ?? null,
            snapshot_id_match: idMatch, payload_hash_match: hashMatch, manifest_hash_match: mhMatch, is_immutable_v2: isV2,
            reason: pass ? 'production latest == INPUT candidate (snapshot_id + payload sha256 + manifest_hash all match)' : reasons.join('; '),
        },
        ctx, candidatePrefix: candidatePrefix(id),
    };
}

// ── source-record FAERS extraction (the source layer) ────────────────────────
/** Pull faers term-count + total from a source record's fda_signals (read-only). */
export function faersFromRecord(rec) {
    const fs = rec?.fda_signals ?? {};
    const terms = Array.isArray(fs.faers_top_adr_terms) ? fs.faers_top_adr_terms : null;
    return {
        present: rec != null,
        faers_term_count: terms ? terms.length : 0,
        faers_total_count: typeof fs.faers_total_top_count === 'number' ? fs.faers_total_top_count : 0,
    };
}

/** Scan a compounds-enriched.jsonl buffer for the requested CIDs + synonym
 * lookups, WITHOUT JSON.parse-ing every line (parse only candidate lines). */
export function scanSourceJsonl(buf, wantCids, synonymTerms) {
    const want = new Set(wantCids.map(Number));
    const lowTerms = (synonymTerms ?? []).map(t => t.toLowerCase());
    const byCid = new Map();
    const synonymHits = new Map(lowTerms.map(t => [t, null]));
    const text = buf.toString('utf-8');
    let start = 0;
    while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end === -1) end = text.length;
        const line = text.slice(start, end);
        start = end + 1;
        if (line.length === 0) continue;
        // Cheap pre-filter: only parse a line that might match a wanted cid or term.
        const lineLow = lowTerms.length ? line.toLowerCase() : line;
        const maybeSyn = lowTerms.some(t => lineLow.includes(t));
        const maybeCid = [...want].some(c => line.includes(`"pubchem_cid":${c}`) || line.includes(`"pubchem_cid": ${c}`));
        if (!maybeSyn && !maybeCid) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const cid = Number(rec.pubchem_cid);
        if (want.has(cid) && !byCid.has(cid)) byCid.set(cid, rec);
        if (lowTerms.length) {
            const syns = Array.isArray(rec.synonyms) ? rec.synonyms.map(s => String(s).toLowerCase()) : [];
            const nm = String(rec.name ?? '').toLowerCase();
            for (const t of lowTerms) {
                if (synonymHits.get(t) == null && (nm === t || syns.includes(t))) synonymHits.set(t, cid);
            }
        }
    }
    return { byCid, synonymHits };
}

// ── three-layer parity rule (§3) ─────────────────────────────────────────────
/**
 * EXACT parity verdict (V3-C contract). s/c/l = source/candidate/live counts:
 *   0,0,0 -> faithful_zero (PASS); s>0,c=0 -> candidate_build_defect (FAIL);
 *   s>0,c>0,l=0 -> serving_defect (FAIL); s=0,c>0,l>0 -> transform_explain
 *   (PASS w/ note); s>0,c>0,l>0 & c==l -> consistent (PASS); else mismatch (FAIL).
 */
export function classifyParity({ source_faers_term_count, candidate_faers_term_count, live_faers_term_count }) {
    const s = Number(source_faers_term_count) || 0;
    const c = Number(candidate_faers_term_count) || 0;
    const l = Number(live_faers_term_count) || 0;
    if (s === 0 && c === 0 && l === 0) return { parity_result: 'faithful_zero', pass: true };
    if (s > 0 && c === 0) return { parity_result: 'candidate_build_defect', pass: false };
    if (s > 0 && c > 0 && l === 0) return { parity_result: 'serving_defect', pass: false };
    if (s === 0 && c > 0 && l > 0) return { parity_result: 'transform_explain', pass: true, note: 'candidate/live carry FAERS the source lacks — a transform/enrich, must be explained (not data loss)' };
    if (s > 0 && c > 0 && l > 0 && c === l) return { parity_result: 'consistent', pass: true };
    return { parity_result: 'mismatch', pass: false, note: `unexpected combo s=${s} c=${c} l=${l}` };
}

// ── repeated-request stability (§6) ──────────────────────────────────────────
/** Given an array of per-repeat probe samples, assert every field is stable. */
export function evalStability(samples, fields) {
    if (!Array.isArray(samples) || samples.length === 0) return { stable: false, reason: 'no samples', samples };
    const first = samples[0];
    for (const s of samples) {
        for (const f of fields) {
            if (JSON.stringify(s?.[f]) !== JSON.stringify(first?.[f])) {
                return { stable: false, reason: `field ${f} flapped across repeats`, field: f, samples };
            }
        }
    }
    return { stable: true, repeats: samples.length, samples };
}
