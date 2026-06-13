/**
 * RK-15 V3-C — shared PURE logic for the STRICT READ-ONLY serving-acceptance
 * harness. Holds the read-only WRITE-GUARD, the surface registry (code-sourced
 * route patterns), the source/candidate/live three-layer parity rules, the
 * repeated-request stability evaluator, and the small read helpers — split out
 * of rk15-v3c-serving-acceptance.js to stay under the CES 250-line cap and to be
 * unit-testable with a mock client + fetch.
 *
 * READ-ONLY CONTRACT: this harness performs ONLY R2 GET/HEAD (source +
 * candidate) and HTTP GET (live worker). It MUST NOT construct ANY PutObject /
 * any write / any latest change / any cache purge. instrumentReadOnlyClient
 * HARD-FAILS the instant a PutObject (or any non-GET/HEAD command) is
 * constructed, and records put_count for the evidence pack (which MUST be 0).
 */

import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

// The fixed Run #1 aggregated source — bound DIRECTLY (NOT via latest.json).
export const SOURCE_RUN_ID = '27413864028';
export const SOURCE_COMPOUNDS_KEY = `processed/aggregated/${SOURCE_RUN_ID}/compounds-enriched.jsonl`;
// The EXACT immutable candidate V3-B CAS-activated to production latest.
export const CANDIDATE_SNAPSHOT_ID = '2026-06-13/27467183738-1';
export const CANDIDATE_PREFIX = `snapshots/${CANDIDATE_SNAPSHOT_ID}/`;

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
 * Wrap `client.send` so EVERY command is inspected BEFORE it reaches R2. The
 * harness is STRICTLY READ-ONLY: a PutObjectCommand (or ANY write/copy/delete
 * command) is a HARD CONTRACT VIOLATION and throws here, never hitting the
 * store. Only GetObjectCommand / HeadObjectCommand are permitted. putCount is
 * tracked on the wrapper and MUST remain 0 for the evidence pack.
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
 * The EXACT parity verdict, per the V3-C contract:
 *   source=0,cand=0,live=0           -> 'faithful_zero'        (NOT a regression)
 *   source>0,cand=0                  -> 'candidate_build_defect'
 *   source>0,cand>0,live=0           -> 'serving_defect'
 *   source=0,cand>0,live>0           -> 'transform_explain'    (explain, not data loss)
 *   source>0,cand>0,live>0 (match)   -> 'consistent'
 * Anything else -> 'mismatch'. `pass` is true only for faithful_zero | consistent
 * | transform_explain (the last carries an explanatory note, not a data-loss).
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
