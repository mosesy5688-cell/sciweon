/**
 * NegEvidence Shard Publisher — PR-T1.1-LEVER (the safe landing zone for the
 * FDA preserve-all uncap).
 *
 * The STORED neg-evidence stays COMPLETE (the whole-file neg-evidence.jsonl.gz
 * is still emitted, additive). This module produces the LATEST-snapshot
 * per-(key,page) range-read optimization so the worker serves ONE entity per
 * request instead of loading the whole file into the 128MB isolate.
 *
 * Reads the validated on-disk neg-evidence.jsonl STREAMING (createReadStream +
 * readline — this is the local validated jsonl, not an R2 stream), assigns
 * negKeyOf (PRESERVE-ALL: every record routes, orphans included), groups by
 * key, sorts each key's records by (key, id), pages into <=NEG_PAGE_SIZE-record
 * entities (each page = one ShardWriter entity = the raw jsonl text of its
 * records, zstd-compressed), and builds PER-BUCKET manifests with rollups.
 *
 * Determinism (Constitution V16.1 §7): (key,id) stable sort + ShardWriter's
 * deterministic zstd => byte-identical shards => stable per-shard sha256.
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';
import { createHash } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ShardWriter } from './shard-writer.js';
import { NEG_BUCKET_COUNT, negKeyOf, negBucketOf } from '../../../src/lib/neg-bucket-hash.js';
import { NEG_EVIDENCE_TYPES } from '../../../src/lib/schemas/neg-evidence-types.js';

export const NEG_PAGE_SIZE = 64;
const MAX_SHARD_BYTES = 10 * 1024 * 1024;
const SEVERITY_ORDER = ['critical', 'major', 'minor', 'unknown'];

function pad4(n) { return String(n).padStart(4, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function bucketPrefix(date, bucket) {
    return `snapshots/${date}/neg-evidence/bucket-${pad4(bucket)}`;
}
function shardKey(date, bucket, shardId) {
    return `${bucketPrefix(date, bucket)}/shard-${pad3(shardId)}.bin`;
}
function manifestKey(date, bucket) {
    return `${bucketPrefix(date, bucket)}/manifest.json`;
}

/**
 * Read the validated jsonl line-by-line. Returns a Map<bucket, Map<key,
 * Array<{id, raw}>>>. PRESERVE-ALL: `skippedMalformed` counts lines that fail
 * JSON.parse so a non-zero count is LOUD (the count guard in stage-4 + the
 * Sum==wc-l gate catch any loss).
 */
export async function groupNegByBucket(jsonlPath) {
    const byBucket = new Map();
    let total = 0;
    let skippedMalformed = 0;
    const stream = createReadStream(jsonlPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.length || !line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); }
        catch { skippedMalformed++; continue; }
        total++;
        const key = negKeyOf(rec);
        const bucket = negBucketOf(key);
        const id = typeof rec.id === 'string' ? rec.id : '';
        if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
        const keyMap = byBucket.get(bucket);
        if (!keyMap.has(key)) keyMap.set(key, []);
        keyMap.get(key).push({ id, severity: rec.severity, evidence_type: rec.evidence_type, raw: line });
    }
    return { byBucket, total, skippedMalformed };
}

function pageRecords(records) {
    // deterministic (key already fixed within a group): sort by id
    records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const pages = [];
    for (let i = 0; i < records.length; i += NEG_PAGE_SIZE) {
        pages.push(records.slice(i, i + NEG_PAGE_SIZE));
    }
    return pages;
}

function severityIndex(severity) {
    const si = SEVERITY_ORDER.indexOf(severity);
    return si >= 0 ? si : 3;
}

/**
 * Build the UNFILTERED aggregates PLUS the `sev_by_type` cross-tab that lets the
 * worker serve an event_type-filtered request EXACTLY from the manifest (no
 * full-corpus scan):
 *   - severity_rollup: [critical, major, minor, unknown] over ALL records (key).
 *   - type_rollup: {evidence_type -> count} over ALL records (key).
 *   - sev_by_type: {evidence_type -> [critical, major, minor, unknown]} — the
 *     per-type severity vector. Element-wise summed over a filter set, it is the
 *     exact filtered signals_by_severity; its keys restricted to a filter set is
 *     the exact filtered signals_by_evidence_type. Keys are emitted in a STABLE
 *     (sorted) order so the manifest object is byte-reproducible (Constitution
 *     V16.1 §7 determinism).
 */
function rollups(records) {
    const sev = [0, 0, 0, 0];
    const type = {};
    const sevByTypeRaw = {};
    for (const r of records) {
        const si = severityIndex(r.severity);
        sev[si]++;
        if (typeof r.evidence_type === 'string') {
            type[r.evidence_type] = (type[r.evidence_type] ?? 0) + 1;
            const vec = sevByTypeRaw[r.evidence_type] ?? (sevByTypeRaw[r.evidence_type] = [0, 0, 0, 0]);
            vec[si]++;
        }
    }
    // Stable key order so the serialized manifest is byte-identical across rebuilds.
    const sev_by_type = {};
    for (const t of Object.keys(sevByTypeRaw).sort()) sev_by_type[t] = sevByTypeRaw[t];
    return { severity_rollup: sev, type_rollup: type, sev_by_type };
}

/**
 * Write one bucket's shards + manifest into outputDir. Each key's pages are
 * serialized as the raw jsonl text of their records (newline-joined) and
 * written as ONE ShardWriter entity. Returns { entries, shardFiles }.
 */
async function packBucket(keyMap, outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    const writer = new ShardWriter(outputDir, 'shard');
    await writer.init();
    writer.open();

    const entries = [];
    // Deterministic key order so the shard byte layout is reproducible.
    const keys = [...keyMap.keys()].sort();
    for (const key of keys) {
        const records = keyMap.get(key);
        const pages = pageRecords(records);
        const pageRefs = [];
        for (const page of pages) {
            const payload = Buffer.from(page.map(r => r.raw).join('\n'), 'utf-8');
            if (writer.wouldExceed(payload.length, MAX_SHARD_BYTES) && writer.entityOffsets.length > 0) {
                writer.finalize();
                writer.nextShard();
            }
            const { offset, size } = writer.writeEntity(payload);
            pageRefs.push({ offset, size, count: page.length, shard: writer.shardId });
        }
        const { severity_rollup, type_rollup, sev_by_type } = rollups(records);
        entries.push({
            key,
            shard: pageRefs.length ? pageRefs[0].shard : writer.shardId,
            total: records.length,
            severity_rollup,
            type_rollup,
            sev_by_type,
            pages: pageRefs.map(p => ({ offset: p.offset, size: p.size, count: p.count, shard: p.shard })),
        });
    }
    writer.finalize();

    const shardFiles = [];
    for (let i = 0; i <= writer.shardId; i++) {
        const filename = `shard-${pad3(i)}.bin`;
        const buf = await fs.readFile(path.join(outputDir, filename)).catch(() => null);
        if (!buf) continue;
        shardFiles.push({ shardId: i, filename, bytes: buf, sha256: sha256(buf) });
    }
    return { entries, shardFiles };
}

function buildManifest(date, bucket, entries, shardFiles) {
    return {
        version: '1.0',
        bucket,
        snapshot_date: date,
        generated_at: new Date().toISOString(),
        total_records: entries.reduce((s, e) => s + e.total, 0),
        shard_count: shardFiles.length,
        entries,
        shard_hashes: shardFiles.map(sf => ({
            shard: sf.shardId, filename: sf.filename, sha256: sf.sha256, size_bytes: sf.bytes.length,
        })),
    };
}

/**
 * Public entry — read jsonl -> group -> per-bucket pack -> upload shards +
 * manifests. Returns { totalRecords, bucketCount, manifestKeys, sumOfTotals }.
 * sumOfTotals is the PRESERVE-ALL gate input (must === wc-l of the jsonl).
 */
export async function publishNegShards({ client, bucket: r2Bucket, jsonlPath, snapshotDate, outputRoot }) {
    const startTime = Date.now();
    console.log(`[NEG-PUBLISHER] Reading ${jsonlPath} (NEG_BUCKET_COUNT=${NEG_BUCKET_COUNT}, page=${NEG_PAGE_SIZE})`);
    const { byBucket, total, skippedMalformed } = await groupNegByBucket(jsonlPath);
    if (skippedMalformed > 0) {
        throw new Error(`[NEG-PUBLISHER] ${skippedMalformed} malformed lines in ${jsonlPath} — refusing to shard (no silent drop)`);
    }
    console.log(`[NEG-PUBLISHER] ${total} records across ${byBucket.size} non-empty buckets`);

    const manifestKeys = [];
    const manifests = [];
    let sumOfTotals = 0;
    let shardCount = 0;
    for (const [bucket, keyMap] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
        const outDir = path.join(outputRoot, snapshotDate, 'neg-evidence', `bucket-${pad4(bucket)}`);
        const { entries, shardFiles } = await packBucket(keyMap, outDir);
        for (const sf of shardFiles) {
            await client.send(new PutObjectCommand({
                Bucket: r2Bucket, Key: shardKey(snapshotDate, bucket, sf.shardId),
                Body: sf.bytes, ContentType: 'application/octet-stream',
            }));
        }
        const manifest = buildManifest(snapshotDate, bucket, entries, shardFiles);
        const mfKey = manifestKey(snapshotDate, bucket);
        await client.send(new PutObjectCommand({
            Bucket: r2Bucket, Key: mfKey, Body: JSON.stringify(manifest), ContentType: 'application/json',
        }));
        manifestKeys.push(mfKey);
        // Keep only the integrity metadata (not the full entries) so the
        // returned object stays small for the verifier.
        manifests.push({ bucket: manifest.bucket, shard_hashes: manifest.shard_hashes });
        sumOfTotals += manifest.total_records;
        shardCount += shardFiles.length;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[NEG-PUBLISHER] ${byBucket.size} buckets, ${shardCount} shards, sum(total)=${sumOfTotals} in ${elapsed}s`);
    return {
        totalRecords: total,
        sumOfTotals,
        bucketCount: byBucket.size,
        shardCount,
        manifestKeys,
        manifests,
        elapsedSec: elapsed,
    };
}

export { NEG_EVIDENCE_TYPES };
