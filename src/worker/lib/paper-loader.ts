/**
 * Paper loader — filters papers.jsonl.gz by mentioned_compounds[].compound_id.
 * Returns all papers that mention the compound from the pinned snapshot.
 *
 * RK-15 PR-A2: the caller reads snapshots/latest.json EXACTLY ONCE and threads
 * the pinned SnapshotContext in; this loader NO LONGER reads latest.json. The
 * object key is derived UNIFORMLY from ctx.object_prefix (v1/v2), so a composed
 * request (repurposing) cannot read latest more than once or cross snapshots.
 */

import { fetchR2GunzippedText } from './r2-fetch';
import { toSourceLoadError } from './source-load-error';
import { type SnapshotContext } from './snapshot-context';

interface MentionEntry {
    compound_id?: string;
}

export async function loadPapersForCompound(
    bucket: R2Bucket,
    ctx: SnapshotContext,
    compoundId: string,
): Promise<Record<string, unknown>[]> {
    try {
        const text = await fetchR2GunzippedText(bucket, `${ctx.object_prefix}papers.jsonl.gz`);
        const records: Record<string, unknown>[] = [];

        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line) as Record<string, unknown>;
                const mentions = (r.mentioned_compounds as MentionEntry[] | null) ?? [];
                if (mentions.some(m => m.compound_id === compoundId)) records.push(r);
            } catch { /* skip malformed line */ }
        }
        return records;
    } catch (err) {
        // RK-13: a source READ failure (pointer fetch / gunzip / object-missing)
        // must NOT be served as an empty result. Classify, emit telemetry, and
        // throw a typed failure the caller maps to a retryable 502/503. The
        // genuine queried_clean case still returns [] above (success path).
        throw toSourceLoadError('papers', `compound:${compoundId}`, err);
    }
}
