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
import { getBucket, shardKeyForCtx } from './compound-bucket-router';
import { loadManifest } from './compound-manifest-loader';
import { decryptPayload, decompressPayload } from './shard-codec';
import {
    type SnapshotContext, loadSnapshotContext, snapshotIdentityToken,
} from './snapshot-context';
import type { Env } from '../../worker';

/**
 * PR-COMPOUND-GUARD (Step-5a): legacy whole-file COMPRESSED-size ceiling.
 *
 * loadTier1Legacy is the deploy-transition FALLBACK (reachable only when
 * compounds_manifest_key is absent); it gunzips the WHOLE compounds-enriched
 * file into the 128MB isolate. With no guard, the FDA preserve-all uncap
 * (which grows fda_signals on the compound RECORD) re-introduces the 45K-cliff
 * OOM. This is a LOUD 503 safety net — the sharded path + projections are
 * primary.
 *
 * Value choice (96MB compressed): today's compounds-enriched.jsonl.gz at
 * ~129,798 compounds is on the order of ~40-60MB compressed (~1.9KB/compound
 * uncompressed * 130K ~= 245MB uncompressed, gzip ~4-6x). 96MB sits comfortably
 * ABOVE that with growth headroom (so the guard does NOT 503 a legitimate
 * current load) yet a 96MB .gz gunzips to ~400-580MB — which OOMs the 128MB
 * isolate — so the guard catches the post-uncap runaway BEFORE the gunzip.
 * The neg sibling (LEGACY_MAX_BYTES=48MB) bounds a structurally smaller file;
 * the compound file is already larger today, so this ceiling is higher.
 *
 * OPERATOR NOTE: confirm + tune via an R2 head of the live .gz; override at
 * runtime with the env var COMPOUNDS_MAX_BYTES (bytes).
 */
export const COMPOUNDS_MAX_BYTES = 96 * 1024 * 1024;

function compoundsMaxBytes(env: Env): number {
    const raw = env.COMPOUNDS_MAX_BYTES;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return COMPOUNDS_MAX_BYTES;
}

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
    const r2 = env.SCIWEON_R2;

    // RK-15 PR-A — read latest.json EXACTLY ONCE per request and pin it. The
    // dual-contract parser throws SnapshotContractError on unknown/mixed/corrupt
    // (LOUD; propagates to the API as a 500/integrity error). The SAME ctx is
    // threaded into BOTH the sharded path and the deploy-transition legacy path
    // below — neither re-reads latest.json.
    const ctx = await loadSnapshotContext(k => fetchR2JsonText(r2, k));

    try {
        // Sharded path ran to completion. Null means CID not in manifest —
        // authoritative absence, return null directly (caller will 404).
        // Wave I-7a Phase 1 perf fix: do NOT fall back to legacy gunzip on
        // CID-absent case. Legacy at 45K+ cumulative crashes Worker (the 503
        // cliff that triggered this whole work). Only fall back when sharded
        // path itself THROWS (manifest missing during deploy transition).
        return await loadTier1Sharded(env, ctx, cid);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[compound-loader] Shard path failed (${msg}), falling back to legacy gunzip`);
        return loadTier1Legacy(env, ctx, cid);
    }
}

async function loadTier1Sharded(env: Env, ctx: SnapshotContext, cid: number): Promise<CompoundRecord | null> {
    const r2 = env.SCIWEON_R2!;
    // v2 declares compounds_manifest_key; v1 derives it per-bucket from the date.
    // A v1 snapshot with no sharded compounds layout published yet is detected by
    // a missing bucket manifest (loadManifest throws -> legacy fallback). We no
    // longer key off a compounds_manifest_key STRING in latest.json: in v2 the
    // declared key IS the contract, in v1 the date-derived key is the contract.
    if (ctx.layout_version === 'immutable_snapshot_v2' && !ctx.compounds_manifest_key) {
        // A precise v2 always carries compounds_manifest_key (parser enforces);
        // defensive guard keeps the invariant explicit.
        throw new Error('immutable_snapshot_v2 context lacks compounds_manifest_key');
    }
    const bucket = getBucket(cid);
    const manifest = await loadManifest(r2, bucket, ctx);
    const entry = manifest.byCid.get(cid);
    if (!entry) return null; // not present in current snapshot; do NOT fall back, this is authoritative

    const key = shardKeyForCtx(ctx, bucket, entry.shard);
    // Identity-bound range cache: the range cache key embeds the snapshot
    // identity so a stale entry can NEVER index a different snapshot's shard
    // bytes at the same (key, offset, length).
    const bytes = await fetchR2RangeBytes(r2, key, entry.offset, entry.size, snapshotIdentityToken(ctx));
    const decrypted = decryptPayload(bytes, key, entry.offset, env);
    const text = decompressPayload(decrypted);
    return JSON.parse(text);
}

/**
 * Legacy gunzip path — kept as the deploy-transition fallback during I-7a
 * rollout (reachable when compounds_manifest_key is absent).
 *
 * PR-COMPOUND-GUARD: a head().size guard (mirroring neg-evidence-loader's
 * LEGACY_MAX_BYTES) refuses to gunzip an oversized whole-file into the isolate
 * — a LOUD throw (the caller surfaces a 503) instead of an OOM. The guard
 * error PROPAGATES (it is not caught by the surrounding try) so the OOM signal
 * is never silently swallowed into a false 404.
 */
async function loadTier1Legacy(env: Env, ctx: SnapshotContext, cid: number): Promise<CompoundRecord | null> {
    const bucket = env.SCIWEON_R2!;
    // RK-15 PR-A: the legacy whole-file path is the legacy_v1 deploy-transition
    // fallback only. It NEVER re-reads latest.json — it uses the SAME pinned ctx
    // and derives the whole-file key from the pinned object_prefix. A v2 snapshot
    // has no legacy whole-file contract, so the fallback is v1-only.
    if (ctx.layout_version !== 'legacy_v1') {
        // v2 sharded read failed and there is no v2 whole-file fallback ->
        // surface the failure (do not silently 404).
        return null;
    }
    const key = `${ctx.object_prefix}compounds-enriched.jsonl.gz`;
    // head().size OOM guard — OUTSIDE the catch so it surfaces (503), not null.
    const head = await bucket.head(key);
    if (!head) return null; // absent file -> authoritative null (caller 404s)
    const maxBytes = compoundsMaxBytes(env);
    if (head.size > maxBytes) {
        throw new Error(
            `Legacy compounds-enriched ${key} is ${head.size} bytes (> ${maxBytes}); ` +
            `sharded path required (OOM guard, COMPOUNDS_MAX_BYTES).`,
        );
    }
    try {
        const text = await fetchR2GunzippedText(bucket, key);
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
