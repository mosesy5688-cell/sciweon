/**
 * Dual-tier compound lookup — Wave I-7a Phase 1 rewrite.
 *
 * Tier 1 (fast, sharded): snapshots/latest.json → manifest → Range fetch
 *   - Phase 1 (this): bucket=1, JSON manifest, NXVF V4.1 binary shards
 *   - Phase 2 (I-8, 1M trigger): WASM SQLite split-DB
 *   - Phase 3 (I-9, 10M trigger): 1024 hash buckets
 *   - Phase 4 (I-10, 100M trigger): + Bloom filter + Iceberg manifest
 * Tier 2 (fallback, stub): bulk/pubchem/{YYYY-MM}/index.json → shard → scan
 *
 * Per Gemini review 2026-05-21 Concern #3 (deployment safety): loadTier1
 * is a try-catch wrapper. After PR merge + worker deploy + F4 not yet run,
 * shards don't exist in R2 — Sharded path throws → Legacy gunzip fallback
 * keeps API alive until first F4 produces shards. Removed in cleanup PR
 * after 1-week stable.
 */

import { fetchR2GunzippedText, fetchR2JsonText, fetchR2RangeBytes } from './r2-fetch';
import { getBucket, shardKeyFor } from './compound-bucket-router';
import { loadManifest } from './compound-manifest-loader';
import { decryptPayload, decompressPayload } from './shard-codec';
import type { Env } from '../../worker';

interface ShardEntry {
    cid_range: [number, number];
    r2_key: string;
}

interface BulkIndex {
    shards: ShardEntry[];
}

interface LatestPointer {
    latest_snapshot_date?: string;
    manifest_key?: string;
    compounds_manifest_key?: string;
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
            if ((r.pubchem_cid as number) === cid) return r;
        } catch { /* skip malformed line */ }
    }
    return null;
}

export type CompoundRecord = Record<string, unknown>;

/**
 * loadTier1 — outer wrapper with legacy fallback (Gemini review #3).
 *
 * Phase 1 path: snapshots/latest.json → compounds_manifest_key → loadManifest
 *   → byCid lookup → R2 Range fetch (1 record, ~2KB) → decode.
 * Legacy fallback: existing full-snapshot gunzip+scan when sharded path
 *   throws (deploy transition, missing shards, missing key, etc.).
 */
export async function loadTier1(env: Env, cid: number): Promise<CompoundRecord | null> {
    if (!env.SCIWEON_R2) return null;
    try {
        const sharded = await loadTier1Sharded(env, cid);
        if (sharded !== null) return sharded;
        // Sharded returned null (record not in manifest). Could be legacy-only
        // snapshot still — fall through to legacy.
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[compound-loader] Shard path failed (${msg}), falling back to legacy gunzip`);
    }
    return loadTier1Legacy(env.SCIWEON_R2, cid);
}

async function loadTier1Sharded(env: Env, cid: number): Promise<CompoundRecord | null> {
    const r2 = env.SCIWEON_R2!;
    const ptrText = await fetchR2JsonText(r2, 'snapshots/latest.json');
    const ptr = JSON.parse(ptrText) as LatestPointer;
    const snapshotDate = ptr.latest_snapshot_date;
    if (!snapshotDate || !ptr.compounds_manifest_key) {
        // No sharded manifest published yet → caller will fall back to legacy
        throw new Error('No compounds_manifest_key in latest.json — sharded path not yet active');
    }
    const bucket = getBucket(cid);
    const manifest = await loadManifest(r2, bucket, snapshotDate);
    const entry = manifest.byCid.get(cid);
    if (!entry) return null; // not present in current snapshot; do NOT fall back, this is authoritative

    const key = shardKeyFor(snapshotDate, bucket, entry.shard);
    const bytes = await fetchR2RangeBytes(r2, key, entry.offset, entry.size);
    const decrypted = decryptPayload(bytes, key, entry.offset, env);
    const text = await decompressPayload(decrypted);
    return JSON.parse(text);
}

/**
 * Legacy gunzip path — kept as fallback during I-7a rollout. Will be removed
 * in cleanup PR after 1 week of production stability with sharded path.
 */
async function loadTier1Legacy(bucket: R2Bucket, cid: number): Promise<CompoundRecord | null> {
    try {
        const ptrText = await fetchR2JsonText(bucket, 'snapshots/latest.json');
        const ptr = JSON.parse(ptrText) as LatestPointer;
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
