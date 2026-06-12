/**
 * Paper loader — filters papers.jsonl.gz by mentioned_compounds[].compound_id.
 * Returns all papers that mention the compound from the latest snapshot.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';
import { toSourceLoadError } from './source-load-error';

interface MentionEntry {
    compound_id?: string;
}

export async function loadPapersForCompound(
    bucket: R2Bucket,
    compoundId: string,
): Promise<Record<string, unknown>[]> {
    try {
        const ptrText = await fetchR2JsonText(bucket, 'snapshots/latest.json');
        const { latest_snapshot_date: date } = JSON.parse(ptrText) as { latest_snapshot_date?: string };
        if (!date) return [];

        const text = await fetchR2GunzippedText(bucket, `snapshots/${date}/papers.jsonl.gz`);
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
