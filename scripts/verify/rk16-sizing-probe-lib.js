/**
 * RK-16 READ-ONLY SIZING PROBE -- snapshot binding + STREAMING scanners (no
 * process exit, no top-level I/O: unit-testable with a mock S3 client + tiny
 * gzipped fixtures).
 *
 * READ-ONLY CONTRACT: every R2 call routes through the P8R1 read-only guard
 * (instrumentReadOnlyClient). Only ListObjectsV2 / HeadObject / GetObject are
 * ever issued -- ZERO Put/Delete/Copy/Multipart, zero latest mutation, zero
 * shard generation. The guard refuses (and counts) anything else BEFORE it
 * reaches the store.
 *
 * SNAPSHOT BINDING: latest.json is read EXACTLY ONCE via the guarded client,
 * parsed with the reader's OWN parseSnapshotContext, and snapshot_id is
 * asserted === EXPECTED_SNAPSHOT_ID. A drift => HARD FAIL (the caller exits
 * nonzero); we NEVER auto-accept a drifted snapshot. All subsequent reads are
 * under the parsed IMMUTABLE object_prefix only.
 *
 * STREAMING: the large gz files are processed with Node-side streaming gunzip +
 * line counting (GetObject body -> zlib.createGunzip() -> readline) -- the whole
 * object is NEVER buffered. Per-record byte lengths accumulate into a numeric
 * array (for percentiles); unique-id / edge sets use Set<string>. RUNNER MEMORY
 * ASSUMPTION: the GHA runner holds the per-family id/edge Sets + the per-record
 * byte-length array in memory (bounded by corpus cardinality, not file bytes);
 * we never hold a whole decompressed file. A future spike with a far larger
 * corpus may need an external/streamed sketch instead.
 */

import zlib from 'zlib';
import readline from 'readline';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { parseSnapshotContext } from '../../src/worker/lib/snapshot-context.ts';

export const PROD_LATEST_KEY = 'snapshots/latest.json';
export const DEFAULT_EXPECTED_SNAPSHOT_ID = '2026-06-14/27502029137-1';

// -- snapshot binding (latest.json read EXACTLY ONCE; hard-fail on drift) ------

export class SnapshotDriftError extends Error {
    constructor(expected, actual) {
        super(`[RK16] snapshot drift: latest.snapshot_id=${JSON.stringify(actual)} !== expected ${JSON.stringify(expected)} -- refusing to auto-accept the drifted snapshot (HARD FAIL)`);
        this.name = 'SnapshotDriftError';
        this.expected = expected;
        this.actual = actual;
    }
}

/**
 * Read snapshots/latest.json ONCE through the guarded client, parse with the
 * reader's parseSnapshotContext, assert snapshot_id === expectedSnapshotId.
 * Returns { ctx, object_prefix, snapshot_id }. Throws SnapshotDriftError on a
 * mismatch (do NOT auto-accept). Throws (parse error) on a non-v2/corrupt
 * latest.
 */
export async function bindSnapshot(client, bucket, expectedSnapshotId) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: PROD_LATEST_KEY }));
    const raw = await streamToString(res.Body);
    const ctx = parseSnapshotContext(raw); // throws on corrupt/legacy/mixed.
    if (ctx.snapshot_id !== expectedSnapshotId) {
        throw new SnapshotDriftError(expectedSnapshotId, ctx.snapshot_id);
    }
    return { ctx, object_prefix: ctx.object_prefix, snapshot_id: ctx.snapshot_id, layout_version: ctx.layout_version };
}

async function streamToString(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body.toString('utf-8');
    const chunks = [];
    for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks).toString('utf-8');
}

// -- read-only primitives ------------------------------------------------------

/** HEAD an object -> { size } or null when it does not exist (404/NoSuchKey). */
export async function headSize(client, bucket, key) {
    try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return r.ContentLength ?? r.Size ?? 0;
    } catch (err) {
        if (is404(err)) return null;
        throw err;
    }
}

function is404(err) {
    return err?.name === 'NotFound' || err?.name === 'NoSuchKey'
        || err?.$metadata?.httpStatusCode === 404;
}

/** List every object under a prefix (paged) -> [{ key, size }]. */
export async function listAll(client, bucket, prefix) {
    const out = [];
    let token;
    do {
        const r = await client.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token,
        }));
        for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size ?? 0 });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
}

/**
 * STREAMING gunzip + per-line scan. Issues a GetObjectCommand THROUGH the
 * guarded client, pipes res.Body -> zlib.createGunzip() -> readline, invoking
 * `onLine(parsedOrNull, rawLine)` per non-empty line. The whole object is NEVER
 * buffered. Returns { record_count } (lines that parsed as JSON). Malformed
 * lines are skipped (onLine receives null) -- mirrors the worker loaders.
 */
export async function streamGunzipLines(client, bucket, key, onLine) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body; // Node Readable (AWS SDK v3 on Node).
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({ input: body.pipe(gunzip), crlfDelay: Infinity });
    let record_count = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { parsed = null; }
        if (parsed !== null) record_count += 1;
        onLine(parsed, line);
    }
    return { record_count };
}

// -- PAPERS family scan --------------------------------------------------------

/**
 * Stream papers.jsonl.gz: per-record byte length, paper id Set, served
 * mentioned_compounds edges (compound_id::paper_id) + per-compound mention
 * degree. Returns the raw accumulators (metrics computed by the metrics module).
 */
export async function scanPapers(client, bucket, objectPrefix) {
    const key = `${objectPrefix}papers.jsonl.gz`;
    const recordBytes = [];
    const paperIds = new Set();
    const mentionEdges = [];
    const mentionDegree = new Map(); // mentioned_compounds degree per paper.
    await streamGunzipLines(client, bucket, key, (rec, raw) => {
        if (!rec) return;
        recordBytes.push(Buffer.byteLength(raw, 'utf-8'));
        const pid = rec.id;
        if (typeof pid === 'string') paperIds.add(pid);
        const mentions = Array.isArray(rec.mentioned_compounds) ? rec.mentioned_compounds : [];
        mentionDegree.set(pid, mentions.length);
        for (const m of mentions) {
            if (m && typeof m.compound_id === 'string') {
                mentionEdges.push({ compound_id: m.compound_id, paper_id: pid });
            }
        }
    });
    return { key, recordBytes, paperIds, mentionEdges, mentionDegree };
}

/** Stream paper-links.jsonl.gz -> array of {compound_id, paper_id} edges. */
export async function scanPaperLinks(client, bucket, objectPrefix) {
    const key = `${objectPrefix}paper-links.jsonl.gz`;
    const linkEdges = [];
    await streamGunzipLines(client, bucket, key, (rec) => {
        if (rec && typeof rec.compound_id === 'string') {
            linkEdges.push({ compound_id: rec.compound_id, paper_id: rec.paper_id });
        }
    });
    return { key, linkEdges };
}

// -- BIOACTIVITIES family scan -------------------------------------------------

/**
 * Stream bioactivities.jsonl.gz: per-compound + per-target degree Maps,
 * compound/target cardinality, uniprot + chembl-target coverage, is_active +
 * activity_type tallies. compound_id / target_id / target.uniprot_accession /
 * is_active / activity_type per the bioactivity schema.
 */
export async function scanBioactivities(client, bucket, objectPrefix) {
    const key = `${objectPrefix}bioactivities.jsonl.gz`;
    const compoundDegree = new Map();
    const targetDegree = new Map();
    const isActive = new Map();
    const activityType = new Map();
    let rows = 0, withUniprot = 0, withTargetId = 0;
    await streamGunzipLines(client, bucket, key, (rec) => {
        if (!rec) return;
        rows += 1;
        const cid = rec.compound_id;
        if (typeof cid === 'string') compoundDegree.set(cid, (compoundDegree.get(cid) || 0) + 1);
        const tid = rec.target_id;
        if (typeof tid === 'string' && tid.length) {
            targetDegree.set(tid, (targetDegree.get(tid) || 0) + 1);
            withTargetId += 1;
        }
        if (rec.target && typeof rec.target.uniprot_accession === 'string' && rec.target.uniprot_accession.length) {
            withUniprot += 1;
        }
        const ia = rec.is_active;
        isActive.set(ia === undefined ? 'undefined' : ia, (isActive.get(ia === undefined ? 'undefined' : ia) || 0) + 1);
        const at = typeof rec.activity_type === 'string' ? rec.activity_type : 'unknown';
        activityType.set(at, (activityType.get(at) || 0) + 1);
    });
    return { key, rows, withUniprot, withTargetId, compoundDegree, targetDegree, isActive, activityType };
}

// -- REPURPOSING INPUTS availability (HEAD/List only -- no whole-file read) -----

/**
 * Trials + trial-links + neg-evidence availability. Trials/trial-links record
 * counts come from a streaming line scan ONLY when the object is present (HEAD
 * first). Neg manifests are LISTED under <prefix>neg-evidence/ (count of
 * bucket manifest.json); the legacy whole-file neg-evidence.jsonl.gz presence is
 * a HEAD. candidate_compound_count is supplied by the caller (edge-derived).
 */
export async function scanRepurposingInputs(client, bucket, objectPrefix) {
    const trialsKey = `${objectPrefix}trials.jsonl.gz`;
    const trialLinksKey = `${objectPrefix}trial-links.jsonl.gz`;
    const trialsSize = await headSize(client, bucket, trialsKey);
    const trialLinksSize = await headSize(client, bucket, trialLinksKey);
    let trials_record_count = null, trial_links_record_count = null;
    if (trialsSize !== null) {
        trials_record_count = (await streamGunzipLines(client, bucket, trialsKey, () => {})).record_count;
    }
    if (trialLinksSize !== null) {
        trial_links_record_count = (await streamGunzipLines(client, bucket, trialLinksKey, () => {})).record_count;
    }

    const negPrefix = `${objectPrefix}neg-evidence/`;
    const negObjects = await listAll(client, bucket, negPrefix);
    const negManifests = negObjects.filter(o => o.key.endsWith('/manifest.json'));
    const legacyNegSize = await headSize(client, bucket, `${objectPrefix}neg-evidence.jsonl.gz`);

    return {
        trials_availability: {
            trials_present: trialsSize !== null,
            trials_compressed_bytes: trialsSize,
            trials_record_count,
            trial_links_present: trialLinksSize !== null,
            trial_links_compressed_bytes: trialLinksSize,
            trial_links_record_count,
        },
        neg_evidence_availability: {
            sharded_manifests_present: negManifests.length > 0,
            neg_manifest_count: negManifests.length,
            legacy_whole_file_present: legacyNegSize !== null,
            legacy_compressed_bytes: legacyNegSize,
        },
    };
}
