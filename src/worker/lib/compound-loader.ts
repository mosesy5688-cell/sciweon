/**
 * Dual-tier compound lookup (V0.6 B.4).
 *
 * Tier 1 (fast, enriched): snapshots/latest.json → snapshots/{date}/compounds-enriched.jsonl.gz
 * Tier 2 (fallback, stub): bulk/pubchem/{YYYY-MM}/index.json → shard → scan
 *
 * Both tiers are cached per-isolate by r2-fetch (keyed by R2 etag), so the
 * first call in an isolate pays the download + decompress cost; subsequent
 * calls in the same isolate hit the in-memory cache.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';

interface ShardEntry {
    cid_range: [number, number];
    r2_key: string;
}

interface BulkIndex {
    shards: ShardEntry[];
}

function cidRunMonths(): string[] {
    const d = new Date();
    const cur = d.toISOString().slice(0, 7);
    d.setMonth(d.getMonth() - 1);
    const prev = d.toISOString().slice(0, 7);
    return [cur, prev];
}

function scanJsonlForCid(text: string, cid: number): Record<string, unknown> | null {
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line) as Record<string, unknown>;
            // Field is pubchem_cid in Sciweon schema (mapPubchemRecord output).
            if ((r.pubchem_cid as number) === cid) return r;
        } catch { /* skip malformed line */ }
    }
    return null;
}

export type CompoundRecord = Record<string, unknown>;

export async function loadTier1(bucket: R2Bucket, cid: number): Promise<CompoundRecord | null> {
    try {
        const ptrText = await fetchR2JsonText(bucket, 'snapshots/latest.json');
        const ptr = JSON.parse(ptrText) as { latest_snapshot_date?: string };
        const date = ptr.latest_snapshot_date;
        if (!date) return null;
        const text = await fetchR2GunzippedText(bucket, `snapshots/${date}/compounds-enriched.jsonl.gz`);
        return scanJsonlForCid(text, cid);
    } catch {
        return null;
    }
}

export async function loadTier2(bucket: R2Bucket, cid: number): Promise<CompoundRecord | null> {
    for (const runMonth of cidRunMonths()) {
        try {
            const indexText = await fetchR2JsonText(bucket, `bulk/pubchem/${runMonth}/index.json`);
            const index = JSON.parse(indexText) as BulkIndex;
            const shard = index.shards.find(
                s => Array.isArray(s.cid_range) && s.cid_range[0] <= cid && cid <= s.cid_range[1],
            );
            if (!shard) continue;
            const text = await fetchR2GunzippedText(bucket, shard.r2_key);
            const record = scanJsonlForCid(text, cid);
            if (record) return { ...record, _bulk_month: runMonth };
        } catch { /* try previous month or give up */ }
    }
    return null;
}
