/**
 * Compound Shard Publisher — Wave I-7a Phase 1 (drugs-scale architecture).
 *
 * Splits cumulative compounds-enriched.jsonl into NXVF V4.1 binary shards
 * (8-10 MB each) + JSON manifest, uploaded under
 * `snapshots/<date>/compounds/bucket-0000/`. Workers do CID -> (shard, offset,
 * size) lookup + R2 Range request, avoiding the full-bundle gunzip+scan (the
 * 45K cliff that triggered I-7a).
 *
 * Constitutional alignment (V16.1): §1.4 R2-single-storage; §1.9 GHA-only
 * mutation; §5.2 NXVF V4.1 8-10MB shards (shard-writer.js); §7 determinism
 * (CID-asc stable sort + sha256/shard); §9 drain 90s + 3 integrity probes.
 *
 * Forward-compat invariants (I-8/9/10): path layout
 * `snapshots/<date>/compounds/bucket-NNNN/shard-MMM.bin`; manifest entry always
 * carries `bucket` (Phase 1: 0); publishCompoundShards() boundary unchanged.
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
export const MAX_SHARD_BYTES = 10 * 1024 * 1024;

// PR-COMPOUND-GUARD F6 hard ceiling: the worker range-fetches a single record
// into the 128MB isolate + decompresses it. A record whose UNCOMPRESSED size
// exceeds this threatens the isolate even ALONE -> the only hard-fail beyond the
// no-silent-drop gate (normal records ~2KB; 64MB is corrupt/runaway). Well above
// MAX_SHARD_BYTES so the soft path handles every realistic fat record.
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;

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
export async function readCompoundsInOrder(jsonlPath) {
    const records = [];
    let skippedMalformed = 0;
    let skippedNonNumericCid = 0;
    const stream = createReadStream(jsonlPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); }
        catch { skippedMalformed++; continue; } // count, do not silently drop
        const cid = rec.pubchem_cid;
        if (typeof cid !== 'number') { skippedNonNumericCid++; continue; }
        records.push({
            cid,
            inchi_key: rec.inchi_key ?? null,
            chembl_id: rec.chembl_id ?? null,
            unii: rec.external_ids?.unii ?? null,
            drugbank_id: rec.external_ids?.drugbank_id ?? null,
            raw: Buffer.from(line, 'utf-8'),
        });
    }
    // NO SILENT DROP ([[cross_cycle_silent_data_loss]]): a dropped CID becomes an
    // authoritative /compound/:id 404 all snapshot day, invisible to the snapshot
    // manifest + historical gate. Mirror the neg path: refuse to publish, LOUD.
    if (skippedMalformed + skippedNonNumericCid > 0) {
        throw new Error(`[COMPOUND-SHARD] refusing to publish: ${skippedMalformed + skippedNonNumericCid} records dropped `
            + `(malformed=${skippedMalformed}, nonNumericCid=${skippedNonNumericCid}) -- silent /compound 404 hole [[cross_cycle_silent_data_loss]]`);
    }
    records.sort((a, b) => a.cid - b.cid);
    return records;
}

/**
 * Pack records into NXVF V4.1 shards (≤10 MB each) via ShardWriter. Returns
 * { entries[], shardFiles[], oversizeShardCount, oversizeCids }. F6:
 * fail-soft-loud on a self-oversize record.
 */
export async function packShards(records, outputDir, opts = {}) {
    // opts thresholds default to the module constants (tests inject small ones).
    const maxShard = opts.maxShardBytes ?? MAX_SHARD_BYTES;
    const maxRecord = opts.maxRecordBytes ?? MAX_RECORD_BYTES;
    await fs.mkdir(outputDir, { recursive: true });
    const writer = new ShardWriter(outputDir, 'shard');
    await writer.init();

    const entries = [];
    writer.open();
    let currentShardId = writer.shardId;
    // F6 fail-soft-LOUD: a record whose own raw size exceeds MAX_SHARD_BYTES is
    // isolated into its OWN shard + counted (NOT a hard-fail -- that would halt
    // the daily publish for ALL ~130K compounds over one fat record).
    let oversizeShardCount = 0;
    const oversizeCids = [];
    let isolatedShardOpen = false; // the current shard holds ONLY an oversize record

    for (const rec of records) {
        // F6 SEPARATE hard ceiling: a record beyond the worker range-fetch budget
        // cannot be served safely even alone -> hard-fail LOUD (corrupt/runaway).
        if (rec.raw.length > maxRecord) {
            throw new Error(`[COMPOUND-SHARD] refusing to publish: CID ${rec.cid} record is ${rec.raw.length} bytes `
                + `(> MAX_RECORD_BYTES ${maxRecord}); exceeds the worker single-record range-fetch budget`);
        }
        const selfOversize = rec.raw.length > maxShard;
        // Fresh shard when current would overflow + is non-empty; OR this record is
        // self-oversize + current non-empty; OR the previous record was oversize.
        const needNewShard = (writer.wouldExceed(rec.raw.length, maxShard) && writer.entityOffsets.length > 0)
            || (selfOversize && writer.entityOffsets.length > 0)
            || isolatedShardOpen;
        if (needNewShard) {
            writer.finalize();
            writer.nextShard();
            currentShardId = writer.shardId;
            isolatedShardOpen = false;
        }
        const { offset, size } = writer.writeEntity(rec.raw);
        if (selfOversize) {
            oversizeShardCount++;
            oversizeCids.push(rec.cid);
            isolatedShardOpen = true; // force the NEXT record onto a fresh shard
            console.warn(`[COMPOUND-SHARD] oversize_shard: CID ${rec.cid} raw=${rec.raw.length} bytes `
                + `(> MAX_SHARD_BYTES ${maxShard}) isolated into its own shard ${currentShardId}`);
        }
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
    if (oversizeShardCount > 0) {
        console.warn(`[COMPOUND-SHARD] oversize_shard TOTAL=${oversizeShardCount} cids=[${oversizeCids.join(',')}] -- each isolated (no halt)`);
    }

    const shardFiles = await collectShardFiles(outputDir, writer.shardId);
    return { entries, shardFiles, oversizeShardCount, oversizeCids };
}

/** Read the produced shard .bin files back from disk (for hashing + upload). */
async function collectShardFiles(outputDir, lastShardId) {
    const shardFiles = [];
    for (let i = 0; i <= lastShardId; i++) {
        const filename = `shard-${pad3(i)}.bin`; // matches ShardWriter's padStart(3,'0')
        const buf = await fs.readFile(path.join(outputDir, filename)).catch(() => null);
        if (!buf) continue;
        shardFiles.push({ shardId: i, filename, bytes: buf, sha256: sha256(buf) });
    }
    return shardFiles;
}

/** Upload shards + manifest to R2 (manifest LAST so partial state is unseen). */
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
    // 2. Build manifest (shard hashes for integrity verification)
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
 * Public entry point — read jsonl -> pack shards -> upload. The caller
 * (stage-4) handles the 90s drain + integrity probes + atomic pointer swap.
 */
export async function publishCompoundShards({ client, bucket, jsonlPath, snapshotDate, outputDir }) {
    const startTime = Date.now();
    const records = await readCompoundsInOrder(jsonlPath);
    console.log(`[PUBLISHER] ${records.length} records read (CID-asc), packing NXVF V4.1 shards`);
    const { entries, shardFiles, oversizeShardCount, oversizeCids } = await packShards(records, outputDir);
    console.log(`[PUBLISHER] ${shardFiles.length} shards produced`
        + (oversizeShardCount > 0 ? ` (oversize_shard=${oversizeShardCount}, cids=[${oversizeCids.join(',')}])` : ''));

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
            oversizeShardCount,
            oversizeCids,
        },
    };
}

