/**
 * Bioactivity loader — filters bioactivities.jsonl.gz by compound_id.
 * Returns all matching records from the latest snapshot.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';

export async function loadBioactivitiesForCompound(
    bucket: R2Bucket,
    compoundId: string,
): Promise<Record<string, unknown>[]> {
    try {
        const ptrText = await fetchR2JsonText(bucket, 'snapshots/latest.json');
        const { latest_snapshot_date: date } = JSON.parse(ptrText) as { latest_snapshot_date?: string };
        if (!date) return [];

        const text = await fetchR2GunzippedText(bucket, `snapshots/${date}/bioactivities.jsonl.gz`);
        const records: Record<string, unknown>[] = [];

        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line) as Record<string, unknown>;
                if (r.compound_id === compoundId) records.push(r);
            } catch { /* skip malformed line */ }
        }
        return records;
    } catch {
        return [];
    }
}
