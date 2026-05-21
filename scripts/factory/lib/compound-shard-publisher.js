/**
 * Compound Shard Publisher — Wave I-7a Phase 1 (drugs-scale architecture).
 *
 * Splits cumulative compounds-enriched.jsonl into NXVF V4.1 binary shards
 * (8-10 MB each) + JSON manifest, uploads to R2 under
 * `snapshots/<date>/compounds/bucket-0000/`. Workers later use the manifest
 * to do CID → (shard, offset, size) lookup + R2 Range request, avoiding
 * full-bundle gunzip+scan (the 45K cliff that triggered I-7a).
 *
 * Constitutional alignment (V16.1):
 * - §1.4 R2 single storage (no D1/KV/SaaS)
 * - §1.9 All mutation in GHA Build Zone
 * - §5.2 NXVF V4.1 8-10 MB shards (reuses scripts/factory/lib/shard-writer.js)
 * - §7 Determinism: CID-asc stable sort + sha256 per shard
 * - §9 Drain wait 90s + 3 random integrity probes before pointer swap
 *
 * Forward-compat invariants (Phase 1 establishes for I-8/9/10):
 * - Path layout `snapshots/<date>/compounds/bucket-NNNN/shard-MMM.bin`
 * - Manifest entry always includes `bucket` field (Phase 1: always 0)
 * - publishCompoundShards() boundary unchanged across phases
 *
 * I-8 trigger (1M compound): manifest JSON → WASM SQLite split-DB
 * I-9 trigger (10M compound): bucket=1 → 1024 hash buckets
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';
import { createHash } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ShardWriter } from './shard-writer.js';

// Per Constitution V16.1 §5.2: 8-10 MB physical limit per shard (Edge-Safe).
// Workers per-invocation memory budget can handle a single 10MB shard fetch +
// decompress comfortably; full-snapshot scan (85 MB at 45K compounds) cannot.
const MAX_SHARD_BYTES = 10 * 1024 * 1024;

const PHASE_1_BUCKET = 0;

function pad4(n) { return String(n).padStart(4, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function bucketPrefix(snapshotDate, bucket) {
    return `snapshots/${snapshotDate}/compounds/bucket-${pad4(bucket)}`;
}

function shardKey(snapshotDate, bucket, shardId) {
    return `${bucketPrefix(snapshotDate, bucket)}/shard-${pad3(shardId)}.bin`;
}

function manifestKey(snapshotDate, bucket) {
    return `${bucketPrefix(snapshotDate, bucket)}/manifest.json`;
}

/**
 * Read JSONL records line-by-line in stable CID-asc order. Returns array of
 * { cid, inchi_key, chembl_id, unii, drugbank_id, json } where json is the
 * raw line bytes (preserves exact serialization for determinism).
 */
async function readCompoundsInOrder(jsonlPath) {
    const records = [];
    const stream = createReadStream(jsonlPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); }
        catch { continue; } // skip malformed
        const cid = rec.pubchem_cid;
        if (typeof cid !== 'number') continue;
        records.push({
            cid,
            inchi_key: rec.inchi_key ?? null,
            chembl_id: rec.chembl_id ?? null,
            unii: rec.external_ids?.unii ?? null,
            drugbank_id: rec.external_ids?.drugbank_id ?? null,
            raw: Buffer.from(line, 'utf-8'),
        });
    }
    records.sort((a, b) => a.cid - b.cid);
    return records;
}

/**
 * Pack records into NXVF V4.1 shards (≤10 MB each). Returns
 * { entries[], shardFiles[{shardId, filename, bytes, sha256}] }.
 *
 * Uses ShardWriter (scripts/factory/lib/shard-writer.js) which already
 * implements the constitutional V4.1 header + zstd compression + offset
 * table. shard-crypto.js stub returns null so encryption layer is no-op
 * for Phase 1.
 */
async function packShards(records, outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    const writer = new ShardWriter(outputDir, 'shard');
    await writer.init();

    const entries = [];
    let currentName = writer.open();
    let currentShardId = writer.shardId;

    for (const rec of records) {
        if (writer.wouldExceed(rec.raw.length, MAX_SHARD_BYTES) && writer.entityOffsets.length > 0) {
            writer.finalize();
            currentName = writer.nextShard();
            currentShardId = writer.shardId;
        }
        const { offset, size } = writer.writeEntity(rec.raw);
        entries.push({
            cid: rec.cid,
            inchi_key: rec.inchi_key,
            chembl_id: rec.chembl_id,
            unii: rec.unii,
            drugbank_id: rec.drugbank_id,
            bucket: PHASE_1_BUCKET,
            shard: currentShardId,
            offset,
            size,
        });
    }
    writer.finalize();

    const shardFiles = [];
    const lastShardId = writer.shardId;
    for (let i = 0; i <= lastShardId; i++) {
        const filename = `shard-${pad3(i)}.bin`;
        const full = path.join(outputDir, `shard-${pad3(i).padStart(3, '0')}.bin`);
        // ShardWriter names via internal padStart(3,'0') on shardId, so filename matches.
        const buf = await fs.readFile(full).catch(() => null);
        if (!buf) continue;
        shardFiles.push({ shardId: i, filename, bytes: buf, sha256: sha256(buf) });
    }
    return { entries, shardFiles };
}

/**
 * Upload shards + manifest to R2. Manifest written LAST so partial state
 * is never visible to readers.
 */
async function uploadToR2(client, bucket, snapshotDate, shardFiles, entries) {
    // 1. Upload shards first
    const shardKeys = [];
    for (const sf of shardFiles) {
        const key = shardKey(snapshotDate, PHASE_1_BUCKET, sf.shardId);
        await client.send(new PutObjectCommand({
            Bucket: bucket, Key: key, Body: sf.bytes,
            ContentType: 'application/octet-stream',
        }));
        shardKeys.push(key);
    }

    // 2. Build manifest with shard hashes for integrity verification
    const manifest = {
        version: '1.0',
        bucket: PHASE_1_BUCKET,
        snapshot_date: snapshotDate,
        generated_at: new Date().toISOString(),
        total_records: entries.length,
        shard_count: shardFiles.length,
        entries,
        shard_hashes: shardFiles.map(sf => ({
            shard: sf.shardId,
            filename: sf.filename,
            sha256: sf.sha256,
            size_bytes: sf.bytes.length,
        })),
    };
    const mfKey = manifestKey(snapshotDate, PHASE_1_BUCKET);
    await client.send(new PutObjectCommand({
        Bucket: bucket, Key: mfKey,
        Body: JSON.stringify(manifest),
        ContentType: 'application/json',
    }));

    return { manifestKey: mfKey, shardKeys, manifest };
}

/**
 * Public entry point — orchestrates: read jsonl → pack shards → upload.
 * Caller (stage-4-upload.js) handles 90s drain wait + integrity probes
 * (compound-shard-pointer.js#verifyShardIntegrity) + atomic latest.json
 * pointer swap (compound-shard-pointer.js#updateLatestPointer).
 */
export async function publishCompoundShards({ client, bucket, jsonlPath, snapshotDate, outputDir }) {
    const startTime = Date.now();
    console.log(`[PUBLISHER] Reading ${jsonlPath}`);
    const records = await readCompoundsInOrder(jsonlPath);
    console.log(`[PUBLISHER] ${records.length} records (CID-asc stable sort applied)`);

    console.log(`[PUBLISHER] Packing into NXVF V4.1 shards (≤${MAX_SHARD_BYTES / 1024 / 1024} MB each)`);
    const { entries, shardFiles } = await packShards(records, outputDir);
    console.log(`[PUBLISHER] ${shardFiles.length} shards produced`);

    console.log(`[PUBLISHER] Uploading to R2 ${bucketPrefix(snapshotDate, PHASE_1_BUCKET)}/`);
    const { manifestKey: mfKey, shardKeys, manifest } = await uploadToR2(
        client, bucket, snapshotDate, shardFiles, entries,
    );
    console.log(`[PUBLISHER] Uploaded ${shardKeys.length} shards + manifest ${mfKey}`);

    const totalMB = shardFiles.reduce((s, f) => s + f.bytes.length, 0) / 1024 / 1024;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    return {
        manifestKey: mfKey,
        shardKeys,
        manifest,
        stats: {
            recordCount: records.length,
            shardCount: shardFiles.length,
            totalMB: +totalMB.toFixed(2),
            elapsedSec: elapsed,
        },
    };
}

