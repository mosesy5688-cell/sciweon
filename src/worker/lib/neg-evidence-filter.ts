/**
 * NegEvidence event_type-filtered serving — pure helpers extracted from
 * neg-evidence-loader.ts so the loader stays under the CES 250-line cap and the
 * filtered page-walk stays independently testable.
 *
 * The filtered path serves an event_type-filtered request CORRECTLY on the
 * sharded route: the count + aggregates come O(1) from the manifest entry's
 * `type_rollup` + `sev_by_type` cross-tab (no full-corpus scan), and the page is
 * a filtered page-walk over the FILTERED logical sequence (offset is a
 * filtered-offset). This replaces the prior post-shape signal filter, which
 * left an UNFILTERED total + UNFILTERED pagination on the safety endpoint.
 */

import { fetchR2RangeBytes } from './r2-fetch';
import { type EvidenceType } from './event-type-taxonomy';
import { negBucketOf } from '../../lib/neg-bucket-hash.js';
import type { NegManifestEntry, NegPageRef } from './neg-manifest-loader';
import { decompressPayload } from './shard-codec';
import { negShardKeyForCtx } from './neg-shard-router';
import { type SnapshotContext, snapshotIdentityToken } from './snapshot-context';
import type { NegEvidenceRecord, NegFilteredAgg } from './neg-evidence-response';

/**
 * Read one page entity's records (range-read + strict zstd decode + jsonl parse).
 * Shared by the unfiltered window read AND the filtered page-walk. A decode
 * failure THROWS (strict) -> the caller maps it to a LOUD 503.
 *
 * RK-15 PR-A: shard key derived from the pinned ctx (v2 declared root / v1 date)
 * and the range cache is bound to the snapshot identity so a stale entry can
 * never index a different snapshot's neg shard bytes.
 */
async function readPageEntities(
    bucket: R2Bucket, ctx: SnapshotContext, entryKey: string, page: NegPageRef,
): Promise<NegEvidenceRecord[]> {
    const key = negShardKeyForCtx(ctx, negBucketOf(entryKey), page.shard);
    const bytes = await fetchR2RangeBytes(bucket, key, page.offset, page.size, snapshotIdentityToken(ctx));
    const text = decompressPayload(bytes, true); // strict: decode failure -> throw -> 503
    const recs: NegEvidenceRecord[] = [];
    for (const line of text.split('\n')) {
        if (line.trim()) recs.push(JSON.parse(line) as NegEvidenceRecord);
    }
    return recs;
}

/**
 * UNFILTERED window read (byte-identical to the loader's prior readPageRecords):
 * decode ONLY the page entities overlapping [offset, offset+limit), then slice
 * to the exact window. `decodedStart` is the global record index of the first
 * decoded page, so the final slice realigns to `offset`. For the default page
 * this range-reads <=2 page-entities.
 */
export async function readPageRecords(
    bucket: R2Bucket, ctx: SnapshotContext, entry: NegManifestEntry, offset: number, limit: number,
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
        for (const rec of await readPageEntities(bucket, ctx, entry.key, page)) {
            records.push(rec);
        }
    }
    if (decodedStart === -1) return [];
    const sliceStart = offset - decodedStart; // >= 0 since first page <= offset
    return records.slice(sliceStart, sliceStart + limit);
}

/**
 * Compute the EXACT filtered aggregates O(1) from the manifest entry (no scan):
 *   total      = sum over t in filter of type_rollup[t]
 *   bySeverity = element-wise sum over t in filter of sev_by_type[t]
 *   byType     = type_rollup restricted to t in filter
 * sev_by_type is optional (pre-field manifests): if a filtered type is present
 * in type_rollup but missing from sev_by_type we THROW (LOUD) rather than
 * silently under-report the severity breakdown on the safety endpoint.
 */
export function computeFilteredAgg(entry: NegManifestEntry, filter: Set<EvidenceType>): NegFilteredAgg {
    let total = 0;
    const bySeverity = { critical: 0, major: 0, minor: 0, unknown: 0 };
    const byType: Record<string, number> = {};
    for (const t of filter) {
        const n = entry.type_rollup[t] ?? 0;
        if (n <= 0) continue;
        total += n;
        byType[t] = n;
        const vec = entry.sev_by_type?.[t];
        if (!vec) {
            throw new Error(
                `Neg manifest entry ${entry.key} has type_rollup[${t}]=${n} but no sev_by_type[${t}] ` +
                `— cannot serve a correct filtered severity breakdown (re-publish required).`,
            );
        }
        bySeverity.critical += vec[0] ?? 0;
        bySeverity.major += vec[1] ?? 0;
        bySeverity.minor += vec[2] ?? 0;
        bySeverity.unknown += vec[3] ?? 0;
    }
    return { total, bySeverity, byType };
}

function matchesFilter(rec: NegEvidenceRecord, filter: Set<EvidenceType>): boolean {
    return typeof rec.evidence_type === 'string' && filter.has(rec.evidence_type as EvidenceType);
}

/**
 * Page-walk the FILTERED logical sequence: iterate pages in order, decode each,
 * keep only records matching `filter`, skip the first `offset` filtered records,
 * then collect up to `limit`. STOPS reading further pages once `limit` filtered
 * records are collected — bounding reads to only the pages the window touches.
 */
export async function readFilteredPageRecords(
    bucket: R2Bucket, ctx: SnapshotContext, entry: NegManifestEntry,
    offset: number, limit: number, filter: Set<EvidenceType>,
): Promise<NegEvidenceRecord[]> {
    const out: NegEvidenceRecord[] = [];
    let skipped = 0;
    for (const page of entry.pages) {
        if (out.length >= limit) break;
        const recs = await readPageEntities(bucket, ctx, entry.key, page);
        for (const rec of recs) {
            if (!matchesFilter(rec, filter)) continue;
            if (skipped < offset) { skipped++; continue; }
            out.push(rec);
            if (out.length >= limit) break;
        }
    }
    return out;
}
