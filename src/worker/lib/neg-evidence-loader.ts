/**
 * NegEvidence loader — PR-T1.1-LEVER bounded serving.
 *
 * The STORED neg-evidence stays COMPLETE. This loader bounds ONLY the
 * per-request memory/payload by reading the LATEST snapshot's PER-BUCKET
 * sharded manifest + per-page range-reads, instead of loading the whole
 * neg-evidence file into the 128MB isolate (the OOM the FDA preserve-all
 * uncap would trigger).
 *
 * Dual-path (INVERTED vs the compound loader): manifest key present + object
 * exists -> SHARDED path, where a THROW is a LOUD 503 (never fall back -- that
 * would re-introduce the OOM / mask a corrupt shard as a false-clean on the
 * SAFETY endpoint); key absent (or stale, FIX M4) -> legacy whole-file read
 * (HEAD.size 503-guarded). negBucketOf(key) loads THAT one bucket manifest;
 * an absent entry = authoritative empty (negative_signals_count: 0).
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';
import { type EvidenceType } from './event-type-taxonomy';
import { negBucketOf } from '../../lib/neg-bucket-hash.js';
import { negManifestKeyFor } from './neg-shard-router';
import { loadNegBucketManifest, type NegManifestEntry } from './neg-manifest-loader';
import {
    shapePagedResponse, shapeSummaryResponse,
    type NegEvidenceRecord, type NegPagedResponse, type NegSummary, type NegFilteredAgg,
} from './neg-evidence-response';
import {
    readPageRecords, computeFilteredAgg, readFilteredPageRecords,
} from './neg-evidence-filter';

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

function clampLimit(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_LIMIT;
    return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

/**
 * Sharded paginated load. THROWS on any sharded failure (caller -> 503).
 * Returns the authoritative empty response when the key is not in its bucket.
 *
 * `eventTypeFilter` (non-null, non-empty) makes count/aggregates/pagination
 * describe the FILTERED set: the total + severity + by-type aggregates come
 * O(1) from the manifest (type_rollup + sev_by_type), and the page is a
 * filtered page-walk over the FILTERED logical sequence (offset is a
 * filtered-offset). When null/absent, the UNFILTERED path runs byte-identically
 * to its prior behavior.
 *
 * NOTE: an EMPTY filter Set means the client passed only unknown event_type
 * tokens (matches nothing) — serve the authoritative filtered-empty response,
 * never the unfiltered set.
 */
export async function loadNegEvidencePage(
    bucket: R2Bucket, compoundId: string, baseUrl: string,
    opts?: { offset?: number; limit?: number },
    eventTypeFilter?: Set<EvidenceType> | null,
): Promise<NegPagedResponse> {
    const ptr = await readPointer(bucket);
    if (!ptr.neg_evidence_manifest_key) {
        throw new Error('neg_evidence_manifest_key absent — not a sharded snapshot');
    }
    const date = ptr.latest_snapshot_date!;
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const limit = clampLimit(opts?.limit);
    const filtering = eventTypeFilter != null; // null = no filter; empty Set still filters (-> empty)

    const manifest = await loadNegBucketManifest(bucket, negBucketOf(compoundId), date);
    const entry = manifest.byKey.get(compoundId) ?? null;
    if (!entry) {
        const emptyAgg: NegFilteredAgg | null = filtering
            ? { total: 0, bySeverity: { critical: 0, major: 0, minor: 0, unknown: 0 }, byType: {} }
            : null;
        return shapePagedResponse(compoundId, null, [], offset, limit, date, baseUrl, emptyAgg);
    }
    if (filtering) {
        const filter = eventTypeFilter!;
        const agg = computeFilteredAgg(entry, filter);
        const pageRecords = agg.total > 0
            ? await readFilteredPageRecords(bucket, date, entry, offset, limit, filter)
            : [];
        return shapePagedResponse(compoundId, entry, pageRecords, offset, limit, date, baseUrl, agg);
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
 * FIX M4: does THIS compound's per-bucket neg manifest object exist for the
 * latest date? A head() probe distinguishing a STALE pointer key (object MISSING
 * -> treat as absent -> legacy) from a genuine sharded-read failure (manifest
 * EXISTS, a shard throws -> 503). Does NOT weaken OOM protection.
 */
export async function negBucketManifestExists(bucket: R2Bucket, compoundId: string): Promise<boolean> {
    const ptr = await readPointer(bucket);
    const key = negManifestKeyFor(ptr.latest_snapshot_date!, negBucketOf(compoundId));
    return (await bucket.head(key)) != null;
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
    const sevByType: Record<string, [number, number, number, number]> = {};
    const order = ['critical', 'major', 'minor', 'unknown'];
    for (const r of recs) {
        const i = order.indexOf(r.severity);
        const si = i >= 0 ? i : 3;
        sev[si]++;
        if (typeof r.evidence_type === 'string') {
            type[r.evidence_type] = (type[r.evidence_type] ?? 0) + 1;
            const vec = sevByType[r.evidence_type] ?? (sevByType[r.evidence_type] = [0, 0, 0, 0]);
            vec[si]++;
        }
    }
    return { key, shard: 0, total: recs.length, severity_rollup: sev, type_rollup: type, sev_by_type: sevByType, pages: [] };
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
 *   - manifest key present AND its object EXISTS -> loadNegEvidencePage; any
 *     throw -> NegShardError (LOUD 503, no fallback).
 *   - key absent, OR key present but the manifest object MISSING (FIX M4: a stale
 *     pointer at a shard-less date) -> legacy whole-file read (HEAD.size guarded).
 */
export async function loadNegEvidenceForCompound(
    bucket: R2Bucket, compoundId: string, baseUrl: string,
    eventTypeFilter?: Set<EvidenceType> | null,
    opts?: { offset?: number; limit?: number },
): Promise<NegPagedResponse> {
    // negShardingActive may throw on a failed pointer read -> propagate as-is
    // (API maps not-found/integrity); it is not a sharded-shard failure.
    const sharded = await negShardingActive(bucket);
    // FIX M4: a STALE pointer key (manifest object missing for this date's bucket)
    // -> key-ABSENT -> legacy. Only an EXISTING manifest engages the inverted
    // (throw -> 503) path. A throw from the probe itself is a real failure -> 503.
    let manifestPresent = false;
    if (sharded) {
        try {
            manifestPresent = await negBucketManifestExists(bucket, compoundId);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new NegShardError(`Sharded neg-evidence read failed: ${msg}`);
        }
    }
    if (sharded && manifestPresent) {
        try {
            // event_type filter applied INSIDE the sharded path (filtered total +
            // aggregates O(1) from the manifest + a filtered page-walk).
            return await loadNegEvidencePage(bucket, compoundId, baseUrl, opts, eventTypeFilter);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new NegShardError(`Sharded neg-evidence read failed: ${msg}`);
        }
    }
    return loadNegEvidenceLegacy(bucket, compoundId, baseUrl, eventTypeFilter);
}

export type { NegPagedResponse, NegSummary };
