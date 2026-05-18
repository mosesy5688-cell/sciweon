/**
 * Trial loader — resolves trials for a compound via trial-links.jsonl.gz.
 * Step 1: scan links file → collect NCT IDs for compound.
 * Step 2: scan trials file → return matching trial entities.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';

async function collectNctIds(bucket: R2Bucket, date: string, compoundId: string): Promise<Set<string>> {
    const text = await fetchR2GunzippedText(bucket, `snapshots/${date}/trial-links.jsonl.gz`);
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
    compoundId: string,
): Promise<Record<string, unknown>[]> {
    try {
        const ptrText = await fetchR2JsonText(bucket, 'snapshots/latest.json');
        const { latest_snapshot_date: date } = JSON.parse(ptrText) as { latest_snapshot_date?: string };
        if (!date) return [];

        const nctIds = await collectNctIds(bucket, date, compoundId);
        if (nctIds.size === 0) return [];

        const text = await fetchR2GunzippedText(bucket, `snapshots/${date}/trials.jsonl.gz`);
        const records: Record<string, unknown>[] = [];

        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line) as Record<string, unknown>;
                if (typeof r.nct_id === 'string' && nctIds.has(r.nct_id)) records.push(r);
            } catch { /* skip malformed line */ }
        }
        return records;
    } catch {
        return [];
    }
}
