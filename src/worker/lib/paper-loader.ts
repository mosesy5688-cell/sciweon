/**
 * Paper loader — filters papers.jsonl.gz by mentioned_compounds[].compound_id.
 * Returns all papers that mention the compound from the latest snapshot.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';

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
    } catch {
        return [];
    }
}
