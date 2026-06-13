/**
 * Trial loader — resolves trials for a compound via trial-links.jsonl.gz.
 * Step 1: scan links file → collect NCT IDs for compound.
 * Step 2: scan trials file → return matching trial entities.
 *
 * RK-15 PR-A2: the caller reads snapshots/latest.json EXACTLY ONCE and threads
 * the pinned SnapshotContext in; this loader NO LONGER reads latest.json. Both
 * object keys are derived UNIFORMLY from ctx.object_prefix (v1/v2), so a composed
 * request (repurposing) cannot read latest more than once or cross snapshots.
 */

import { fetchR2GunzippedText } from './r2-fetch';
import { toSourceLoadError } from './source-load-error';
import { type SnapshotContext } from './snapshot-context';

async function collectNctIds(bucket: R2Bucket, ctx: SnapshotContext, compoundId: string): Promise<Set<string>> {
    const text = await fetchR2GunzippedText(bucket, `${ctx.object_prefix}trial-links.jsonl.gz`);
    const ids = new Set<string>();
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line) as { compound_id?: string; nct_id?: string };
            if (r.compound_id === compoundId && r.nct_id) ids.add(r.nct_id);
        } catch { /* skip malformed line */ }
    }
    return ids;
}

export async function loadTrialsForCompound(
    bucket: R2Bucket,
    ctx: SnapshotContext,
    compoundId: string,
): Promise<Record<string, unknown>[]> {
    try {
        const nctIds = await collectNctIds(bucket, ctx, compoundId);
        if (nctIds.size === 0) return [];

        const text = await fetchR2GunzippedText(bucket, `${ctx.object_prefix}trials.jsonl.gz`);
        const records: Record<string, unknown>[] = [];

        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line) as Record<string, unknown>;
                if (typeof r.nct_id === 'string' && nctIds.has(r.nct_id)) records.push(r);
            } catch { /* skip malformed line */ }
        }
        return records;
    } catch (err) {
        // RK-13: a source READ failure (pointer fetch / gunzip of trial-links
        // OR trials / object-missing) must NOT be served as an empty result.
        // Classify, emit telemetry, and throw a typed failure the caller maps to
        // a retryable 502/503. The genuine queried_clean cases (no date / no
        // matching NCT IDs) still return [] above (success path).
        throw toSourceLoadError('trials', `compound:${compoundId}`, err);
    }
}
