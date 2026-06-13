/**
 * NegEvidence loader — PR-T1.1-LEVER bounded serving (+ RK-15 PR-A pinning).
 *
 * The STORED neg-evidence stays COMPLETE; this loader bounds per-request
 * memory by reading the snapshot's PER-BUCKET sharded manifest + per-page
 * range-reads, not the whole file. INVERTED dual-path: manifest key present +
 * object exists -> SHARDED (a THROW is a LOUD 503, never fall back); key absent
 * or stale (FIX M4) -> legacy whole-file read (HEAD.size 503-guarded). An absent
 * bucket entry = authoritative empty. RK-15: latest.json is read ONCE and the
 * pinned SnapshotContext is threaded through every manifest / shard / range read.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';
import { type EvidenceType } from './event-type-taxonomy';
import { negBucketOf } from '../../lib/neg-bucket-hash.js';
import { negManifestKeyForCtx } from './neg-shard-router';
import { loadNegBucketManifest, type NegManifestEntry } from './neg-manifest-loader';
import { type SnapshotContext, loadSnapshotContext } from './snapshot-context';
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

/**
 * RK-15 PR-A: read latest.json EXACTLY ONCE -> pinned dual-contract ctx + the
 * sharding flag. SnapshotContractError PROPAGATES (LOUD). v2: sharding is the
 * declared neg_evidence_manifest_key; legacy_v1: the raw pointer field (the v1
 * contract). One R2 read total (fetchR2JsonText is etag-deduped).
 */
interface NegPointerRaw {
    neg_evidence_manifest_key?: unknown;
}

async function readNegContext(
    bucket: R2Bucket,
): Promise<{ ctx: SnapshotContext; shardingActive: boolean }> {
    const rawText = await fetchR2JsonText(bucket, LATEST_POINTER_KEY);
    const ctx = await loadSnapshotContext(async () => rawText);
    let shardingActive: boolean;
    if (ctx.layout_version === 'immutable_snapshot_v2') {
        shardingActive = ctx.neg_evidence_manifest_key != null;
    } else {
        const raw = JSON.parse(rawText) as NegPointerRaw;
        shardingActive = typeof raw.neg_evidence_manifest_key === 'string'
            && raw.neg_evidence_manifest_key.length > 0;
    }
    return { ctx, shardingActive };
}

function clampLimit(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_LIMIT;
    return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

/**
 * Sharded paginated load. THROWS on any sharded failure (caller -> 503); returns
 * the authoritative empty response when the key is absent from its bucket.
 * `eventTypeFilter` (non-null) makes count/aggregates/pagination describe the
 * FILTERED set (totals O(1) from type_rollup + sev_by_type; filtered page-walk).
 * An EMPTY filter Set serves the filtered-empty response, never the full set.
 */
export async function loadNegEvidencePage(
    bucket: R2Bucket, ctx: SnapshotContext, compoundId: string, baseUrl: string,
    opts?: { offset?: number; limit?: number },
    eventTypeFilter?: Set<EvidenceType> | null,
): Promise<NegPagedResponse> {
    const date = ctx.snapshot_date;
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const limit = clampLimit(opts?.limit);
    const filtering = eventTypeFilter != null; // null = no filter; empty Set still filters (-> empty)

    const manifest = await loadNegBucketManifest(bucket, negBucketOf(compoundId), ctx);
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
            ? await readFilteredPageRecords(bucket, ctx, entry, offset, limit, filter)
            : [];
        return shapePagedResponse(compoundId, entry, pageRecords, offset, limit, date, baseUrl, agg);
    }
    const pageRecords = await readPageRecords(bucket, ctx, entry, offset, limit);
    return shapePagedResponse(compoundId, entry, pageRecords, offset, limit, date, baseUrl);
}

/**
 * Summary load (aggregator): manifest entry rollups + FIRST page only for a
 * few examples. THROWS on sharded failure (caller -> 503).
 */
/** The canonical empty neg-summary (no entry). Used by callers that cannot pin
 * a snapshot context (e.g. an absent latest.json on a best-effort aggregator). */
export function emptyNegSummary(): NegSummary {
    return shapeSummaryResponse(null, []);
}

export async function loadNegEvidenceSummary(
    bucket: R2Bucket, ctx: SnapshotContext, compoundId: string,
): Promise<NegSummary> {
    const manifest = await loadNegBucketManifest(bucket, negBucketOf(compoundId), ctx);
    const entry = manifest.byKey.get(compoundId) ?? null;
    if (!entry) return shapeSummaryResponse(null, []);
    const firstPage = await readPageRecords(bucket, ctx, entry, 0, 5);
    return shapeSummaryResponse(entry, firstPage);
}

/**
 * FIX M4: does THIS compound's per-bucket neg manifest object exist for the
 * pinned snapshot? A head() probe distinguishing a STALE pointer key (object
 * MISSING -> treat as absent -> legacy) from a genuine sharded-read failure
 * (manifest EXISTS, a shard throws -> 503). Uses the pinned ctx; does NOT
 * weaken OOM protection.
 */
export async function negBucketManifestExists(
    bucket: R2Bucket, ctx: SnapshotContext, compoundId: string,
): Promise<boolean> {
    const key = negManifestKeyForCtx(ctx, negBucketOf(compoundId));
    return (await bucket.head(key)) != null;
}

/**
 * LEGACY whole-file read — used ONLY when neg_evidence_manifest_key is ABSENT.
 * HEAD.size 503 guard: refuse to load an oversized legacy file (LOUD) instead
 * of OOMing the isolate.
 */
export async function loadNegEvidenceLegacy(
    bucket: R2Bucket, ctx: SnapshotContext, compoundId: string, baseUrl: string,
    eventTypeFilter?: Set<EvidenceType> | null,
): Promise<NegPagedResponse> {
    const date = ctx.snapshot_date;
    // Whole-file legacy read is the legacy_v1 deploy-transition contract: object
    // key derived from the pinned object_prefix, no re-read of latest.json.
    const key = `${ctx.object_prefix}neg-evidence.jsonl.gz`;
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
    // RK-15 PR-A: read latest.json EXACTLY ONCE -> pinned ctx + the v1 raw
    // sharding flag. A SnapshotContractError (unknown/mixed/corrupt) PROPAGATES
    // as-is (the API maps it to an integrity error); it is NOT a shard failure.
    const { ctx, shardingActive } = await readNegContext(bucket);

    // FIX M4: a STALE pointer key (manifest object missing for this snapshot's
    // bucket) -> key-ABSENT -> legacy. Only an EXISTING manifest engages the
    // inverted (throw -> 503) path. A throw from the probe itself is a real
    // failure -> 503.
    let manifestPresent = false;
    if (shardingActive) {
        try {
            manifestPresent = await negBucketManifestExists(bucket, ctx, compoundId);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new NegShardError(`Sharded neg-evidence read failed: ${msg}`);
        }
    }
    if (shardingActive && manifestPresent) {
        try {
            // event_type filter applied INSIDE the sharded path (filtered total +
            // aggregates O(1) from the manifest + a filtered page-walk).
            return await loadNegEvidencePage(bucket, ctx, compoundId, baseUrl, opts, eventTypeFilter);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new NegShardError(`Sharded neg-evidence read failed: ${msg}`);
        }
    }
    // Legacy whole-file fallback is v1-only (a v2 snapshot has no whole-file
    // contract). For v2 with no sharded manifest published, surface LOUD rather
    // than guess a v1 path.
    if (ctx.layout_version !== 'legacy_v1') {
        throw new NegShardError('immutable_snapshot_v2 has no sharded neg manifest and no whole-file fallback');
    }
    return loadNegEvidenceLegacy(bucket, ctx, compoundId, baseUrl, eventTypeFilter);
}

export type { NegPagedResponse, NegSummary };
