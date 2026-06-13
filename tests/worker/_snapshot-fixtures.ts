// @ts-nocheck
/**
 * RK-15 PR-A2 shared test fixtures — mock R2 + dual-contract snapshot stores
 * used by the reader-stage closure tests. Kept out of the .test.ts file so each
 * test file stays well under the CES Art 5.1 250-line cap.
 */

import { negBucketOf } from '../../src/lib/neg-bucket-hash.js';

// The Cache API is a Workers global; the aggregator's neg-summary path consults
// caches.default. Provide a no-op stub in node so a miss falls through to R2.
if (typeof (globalThis as any).caches === 'undefined') {
    (globalThis as any).caches = { default: { async match() { return undefined; }, async put() { } } };
}

export const LATEST = 'snapshots/latest.json';
export const CID = 'CID:2244';
const NEG_BUCKET = negBucketOf(CID);
const NEG_BUCKET_PAD = String(NEG_BUCKET).padStart(4, '0');

export function gz(text: string): Uint8Array {
    const { gzipSync } = require('zlib');
    return new Uint8Array(gzipSync(Buffer.from(text, 'utf-8')));
}
export function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }

// Mock R2 that COUNTS reads per key. Every fetchR2Object does head() first (even
// on a cache hit), so head-count = "how many times the request consulted the key".
export function makeCountingBucket(store: Record<string, { bytes: Uint8Array; etag: string }>) {
    const headCount: Record<string, number> = {};
    const getCount: Record<string, number> = {};
    const bucket = {
        async head(key: string) {
            headCount[key] = (headCount[key] ?? 0) + 1;
            const o = store[key];
            return o ? { size: o.bytes.length, etag: o.etag } : null;
        },
        async get(key: string, opts?: any) {
            getCount[key] = (getCount[key] ?? 0) + 1;
            const o = store[key];
            if (!o) return null;
            return {
                etag: o.etag,
                async arrayBuffer() {
                    return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength);
                },
            };
        },
    } as unknown as R2Bucket;
    return { bucket, headCount, getCount };
}

export function makeEnv(bucket?: R2Bucket) {
    return { ASSETS: { fetch: () => new Response('x') }, SCIWEON_R2: bucket } as any;
}
export function fakeCtx() {
    return { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;
}

// Unique etag per scenario keeps r2-fetch's module (key,etag) cache from bleeding.
let seq = 0;
export function uniq() { return `e${seq++}`; }

// Empty per-bucket neg manifest: the neg-summary path loads it (pinned prefix),
// finds no entry, returns empty without a shard read.
function emptyNegManifest(date: string) {
    return JSON.stringify({
        version: 'test', bucket: NEG_BUCKET, snapshot_date: date, generated_at: '',
        total_records: 0, shard_count: 0, entries: [], shard_hashes: [],
    });
}

// The four record layers under a pinned prefix `px` (+ an empty neg manifest).
function recordStore(px: string, tag: string, negDate: string) {
    return {
        [`${px}trial-links.jsonl.gz`]: { bytes: gz(JSON.stringify({ compound_id: CID, nct_id: 'NCT1' }) + '\n'), etag: `tl-${tag}` },
        [`${px}trials.jsonl.gz`]: { bytes: gz(JSON.stringify({ nct_id: 'NCT1', status: 'RECRUITING', phase: 2 }) + '\n'), etag: `tr-${tag}` },
        [`${px}bioactivities.jsonl.gz`]: { bytes: gz(JSON.stringify({ id: 'B1', compound_id: CID, is_active: true }) + '\n'), etag: `bi-${tag}` },
        [`${px}papers.jsonl.gz`]: { bytes: gz(JSON.stringify({ id: 'P1', mentioned_compounds: [{ compound_id: CID }], is_retracted: false }) + '\n'), etag: `pa-${tag}` },
        [`${px}neg-evidence/bucket-${NEG_BUCKET_PAD}/manifest.json`]: { bytes: utf8(emptyNegManifest(negDate)), etag: `ng-${tag}` },
    };
}

/** A v1 snapshot store (date-keyed object_prefix = snapshots/<date>/). */
export function v1Store(date: string, tag: string) {
    const px = `snapshots/${date}/`;
    return {
        [LATEST]: { bytes: utf8(JSON.stringify({ latest_snapshot_date: date })), etag: `ptr-${tag}` },
        ...recordStore(px, tag, date),
    };
}

/** A v2 snapshot store (declared object_prefix, not date-derived). */
export function v2Store(prefix: string, snapshotId: string, tag: string) {
    const px = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const ptr = {
        layout_version: 'immutable_snapshot_v2',
        snapshot_id: snapshotId,
        object_prefix: px,
        compounds_manifest_key: `${px}compounds-manifest.json`,
        neg_evidence_manifest_key: `${px}neg-evidence/manifest-root.json`,
    };
    return {
        [LATEST]: { bytes: utf8(JSON.stringify(ptr)), etag: `ptr-${tag}` },
        ...recordStore(px, tag, snapshotId),
    };
}

const TARGET_ENTRY = {
    uniprot_accession: 'P00533', protein_name: 'EGFR', gene_symbol: 'EGFR', chembl_target_id: null,
    organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' },
    compound_ids: [], bioactivity_ids: [], trial_ids: [], negative_evidence_ids: [],
};
/** A target-index store under prefix `px`; `ptrText` defaults to a v1 pointer. */
export function targetStore(px: string, ptrEtag: string, tag: string, ptrText?: string) {
    const date = px.replace(/^snapshots\//, '').replace(/\/$/, '');
    const idx = JSON.stringify({ version: '0.6.0', built_at: '', targets: { P00533: TARGET_ENTRY } });
    return {
        [LATEST]: { bytes: utf8(ptrText ?? JSON.stringify({ latest_snapshot_date: date })), etag: ptrEtag },
        [`${px}target-index.json.gz`]: { bytes: gz(idx), etag: `idx-${tag}` },
    };
}
