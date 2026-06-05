/**
 * NegEvidence loader — PR-T1.1-LEVER bounded serving.
 *
 * The STORED neg-evidence stays COMPLETE. This loader bounds ONLY the
 * per-request memory/payload by reading the LATEST snapshot's PER-BUCKET
 * sharded manifest + per-page range-reads, instead of loading the whole
 * neg-evidence file into the 128MB isolate (the OOM the FDA preserve-all
 * uncap would trigger).
 *
 * Dual-path (INVERTED vs the compound loader):
 *   - latest.json HAS neg_evidence_manifest_key -> SHARDED path. A sharded
 *     THROW is a LOUD failure (caller -> 503); we NEVER fall back to the
 *     legacy whole-file read (that would re-introduce the OOM + could mask a
 *     corrupt shard as a false-clean on the SAFETY endpoint).
 *   - key ABSENT -> legacy whole-file read (deploy-transition / pre-first-F4),
 *     with a HEAD.size 503 guard so a too-large legacy file fails loud rather
 *     than OOMing the isolate.
 *
 * negBucketOf(key) -> load THAT one bucket manifest -> byKey.get(key). Absent
 * entry = authoritative empty (negative_signals_count: 0).
 */

import { fetchR2GunzippedText, fetchR2JsonText, fetchR2RangeBytes } from './r2-fetch';
import { type EvidenceType } from './event-type-taxonomy';
import { negBucketOf } from '../../lib/neg-bucket-hash.js';
import { loadNegBucketManifest, type NegManifestEntry } from './neg-manifest-loader';
import { decompressPayload } from './shard-codec';
import { negShardKeyFor } from './neg-shard-router';
import {
    shapePagedResponse, shapeSummaryResponse,
    type NegEvidenceRecord, type NegPagedResponse, type NegSummary,
} from './neg-evidence-response';

const LATEST_POINTER_KEY = 'snapshots/latest.json';
// Legacy whole-file safety cap: refuse to load a legacy neg-evidence file
// larger than this into the isolate (LOUD 503) rather than OOM. The sharded
// path is the supported route once published.
const LEGACY_MAX_BYTES = 48 * 1024 * 1024;
export const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

interface LatestPointer {
    latest_snapshot_date?: string;
    neg_evidence_manifest_key?: string;
}

async function readPointer(bucket: R2Bucket): Promise<LatestPointer> {
    const text = await fetchR2JsonText(bucket, LATEST_POINTER_KEY);
    const ptr = JSON.parse(text) as LatestPointer;
    if (!ptr.latest_snapshot_date) {
        throw new Error('snapshots/latest.json missing latest_snapshot_date');
    }
    return ptr;
}

/**
 * Decode ONLY the page entities overlapping [offset, offset+limit) for one
 * entry, then slice to the exact window. `decodedStart` is the global record
 * index of the first decoded page, so the final slice realigns to `offset`.
 * For the default page this range-reads <=2 page-entities.
 */
async function readPageRecords(
    bucket: R2Bucket, date: string, entry: NegManifestEntry, offset: number, limit: number,
): Promise<NegEvidenceRecord[]> {
    const records: NegEvidenceRecord[] = [];
    const wantEnd = offset + limit;
    let seen = 0;
    let decodedStart = -1;
    for (const page of entry.pages) {
        const pageStart = seen;
        const pageEnd = seen + page.count;
        seen = pageEnd;
        if (pageEnd <= offset) continue;     // entirely before the window
        if (pageStart >= wantEnd) break;      // entirely after the window
        if (decodedStart === -1) decodedStart = pageStart;
        const key = negShardKeyFor(date, negBucketOf(entry.key), page.shard);
        const bytes = await fetchR2RangeBytes(bucket, key, page.offset, page.size);
        const text = decompressPayload(bytes, true); // strict: decode failure -> throw -> 503
        for (const line of text.split('\n')) {
            if (line.trim()) records.push(JSON.parse(line) as NegEvidenceRecord);
        }
    }
    if (decodedStart === -1) return [];
    const sliceStart = offset - decodedStart; // >= 0 since first page <= offset
    return records.slice(sliceStart, sliceStart + limit);
}

function clampLimit(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_LIMIT;
    return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

/**
 * Sharded paginated load. THROWS on any sharded failure (caller -> 503).
 * Returns the authoritative empty response when the key is not in its bucket.
 */
export async function loadNegEvidencePage(
    bucket: R2Bucket, compoundId: string, baseUrl: string,
    opts?: { offset?: number; limit?: number },
): Promise<NegPagedResponse> {
    const ptr = await readPointer(bucket);
    if (!ptr.neg_evidence_manifest_key) {
        throw new Error('neg_evidence_manifest_key absent — not a sharded snapshot');
    }
    const date = ptr.latest_snapshot_date!;
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const limit = clampLimit(opts?.limit);

    const manifest = await loadNegBucketManifest(bucket, negBucketOf(compoundId), date);
    const entry = manifest.byKey.get(compoundId) ?? null;
    if (!entry) {
        return shapePagedResponse(compoundId, null, [], offset, limit, date, baseUrl);
    }
    const pageRecords = await readPageRecords(bucket, date, entry, offset, limit);
    return shapePagedResponse(compoundId, entry, pageRecords, offset, limit, date, baseUrl);
}

/**
 * Summary load (aggregator): manifest entry rollups + FIRST page only for a
 * few examples. THROWS on sharded failure (caller -> 503).
 */
export async function loadNegEvidenceSummary(
    bucket: R2Bucket, compoundId: string,
): Promise<NegSummary> {
    const ptr = await readPointer(bucket);
    if (!ptr.neg_evidence_manifest_key) {
        throw new Error('neg_evidence_manifest_key absent — not a sharded snapshot');
    }
    const date = ptr.latest_snapshot_date!;
    const manifest = await loadNegBucketManifest(bucket, negBucketOf(compoundId), date);
    const entry = manifest.byKey.get(compoundId) ?? null;
    if (!entry) return shapeSummaryResponse(null, []);
    const firstPage = await readPageRecords(bucket, date, entry, 0, 5);
    return shapeSummaryResponse(entry, firstPage);
}

/** Whether the latest snapshot exposes the sharded neg manifest. */
export async function negShardingActive(bucket: R2Bucket): Promise<boolean> {
    try {
        const ptr = await readPointer(bucket);
        return Boolean(ptr.neg_evidence_manifest_key);
    } catch { return false; }
}

/**
 * LEGACY whole-file read — used ONLY when neg_evidence_manifest_key is ABSENT.
 * HEAD.size 503 guard: refuse to load an oversized legacy file (LOUD) instead
 * of OOMing the isolate.
 */
export async function loadNegEvidenceLegacy(
    bucket: R2Bucket, compoundId: string, baseUrl: string,
    eventTypeFilter?: Set<EvidenceType> | null,
): Promise<NegPagedResponse> {
    const ptr = await readPointer(bucket);
    const date = ptr.latest_snapshot_date!;
    const key = `snapshots/${date}/neg-evidence.jsonl.gz`;
    const head = await bucket.head(key);
    if (!head) throw new Error(`Legacy neg-evidence not found: ${key}`);
    if (head.size > LEGACY_MAX_BYTES) {
        throw new Error(`Legacy neg-evidence ${key} is ${head.size} bytes (> ${LEGACY_MAX_BYTES}); sharded path required.`);
    }
    const text = await fetchR2GunzippedText(bucket, key);
    let matched: NegEvidenceRecord[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line) as NegEvidenceRecord;
            if (rec.subject?.compound_id === compoundId) matched.push(rec);
        } catch { /* defensive: producer gate rejects malformed */ }
    }
    if (eventTypeFilter) {
        matched = matched.filter(r => typeof r.evidence_type === 'string'
            && eventTypeFilter.has(r.evidence_type as EvidenceType));
    }
    // Synthesize a manifest-shaped entry from the matched records so the legacy
    // path uses the same response shaper (rollups computed inline).
    const entry = matched.length ? synthEntry(compoundId, matched) : null;
    return shapePagedResponse(compoundId, entry, matched, 0, matched.length || DEFAULT_PAGE_LIMIT, date, baseUrl);
}

function synthEntry(key: string, recs: NegEvidenceRecord[]): NegManifestEntry {
    const sev: [number, number, number, number] = [0, 0, 0, 0];
    const type: Record<string, number> = {};
    const order = ['critical', 'major', 'minor', 'unknown'];
    for (const r of recs) {
        const i = order.indexOf(r.severity);
        sev[i >= 0 ? i : 3]++;
        if (typeof r.evidence_type === 'string') type[r.evidence_type] = (type[r.evidence_type] ?? 0) + 1;
    }
    return { key, shard: 0, total: recs.length, severity_rollup: sev, type_rollup: type, pages: [] };
}

/**
 * Thrown when the SHARDED path fails (manifest active but a shard/manifest read
 * threw). The API + MCP map this to a LOUD 503 and NEVER fall back to legacy.
 */
export class NegShardError extends Error {
    constructor(message: string) { super(message); this.name = 'NegShardError'; }
}

/**
 * Orchestrator (keeps the public name callers use). INVERTED dual-path:
 *   - sharded manifest present -> loadNegEvidencePage; any throw -> NegShardError
 *     (LOUD 503, no legacy fallback).
 *   - manifest absent -> legacy whole-file read (HEAD.size guarded).
 */
export async function loadNegEvidenceForCompound(
    bucket: R2Bucket, compoundId: string, baseUrl: string,
    eventTypeFilter?: Set<EvidenceType> | null,
    opts?: { offset?: number; limit?: number },
): Promise<NegPagedResponse> {
    let sharded: boolean;
    try {
        sharded = await negShardingActive(bucket);
    } catch (err) {
        // Pointer read failed — propagate as a normal error (API maps not-found
        // / integrity appropriately). Not a sharded-shard failure.
        throw err;
    }
    if (sharded) {
        try {
            const resp = await loadNegEvidencePage(bucket, compoundId, baseUrl, opts);
            // Apply the optional event_type filter to the page (post-shape).
            return eventTypeFilter ? filterByType(resp, eventTypeFilter) : resp;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new NegShardError(`Sharded neg-evidence read failed: ${msg}`);
        }
    }
    return loadNegEvidenceLegacy(bucket, compoundId, baseUrl, eventTypeFilter);
}

function filterByType(resp: NegPagedResponse, filter: Set<EvidenceType>): NegPagedResponse {
    const signals = resp.signals.filter(s => typeof s.evidence_type === 'string'
        && filter.has(s.evidence_type as EvidenceType));
    return { ...resp, signals };
}

export type { NegPagedResponse, NegSummary };
