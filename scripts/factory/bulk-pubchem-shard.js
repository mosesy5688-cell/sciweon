/**
 * PubChem Bulk Shard + R2 Upload — V0.6 Sprint 2 B.3
 *
 * Two modes:
 *   --worker-shard=N   Process output/bulk/worker-N/*.jsonl → shard (1000 CIDs)
 *                      → gzip → upload shards + per-worker manifest to R2.
 *   --build-index-only Download 8 per-worker manifests from R2 → merge →
 *                      upload global index.json.
 *
 * R2 layout:
 *   bulk/pubchem/YYYY-MM/shards/shard-cid-XXXXXXXXX-XXXXXXXXX.jsonl.gz
 *   bulk/pubchem/YYYY-MM/workers/worker-N.json     (per-worker manifest)
 *   bulk/pubchem/YYYY-MM/index.json                (global, uploaded last)
 *
 * Usage:
 *   node bulk-pubchem-shard.js --worker-shard=0 --run-month=2026-05
 *   node bulk-pubchem-shard.js --build-index-only --run-month=2026-05 --worker-total=8
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import readline from 'readline';
import {
    makeR2Client, sha256hex, buildShardKey, compressBuf,
    uploadBuf, uploadWorkerManifest, downloadWorkerManifest, uploadGlobalIndex,
} from './lib/bulk-shard-helpers.js';

const SHARD_SIZE = 1000;
const BULK_OUTPUT = './output/bulk';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        workerShard: null, buildIndexOnly: false,
        runMonth: new Date().toISOString().slice(0, 7),
        workerTotal: 8, dryRun: false,
    };
    for (const a of args) {
        if (a.startsWith('--worker-shard=')) opts.workerShard = parseInt(a.split('=')[1], 10);
        else if (a.startsWith('--run-month=')) opts.runMonth = a.split('=')[1];
        else if (a.startsWith('--worker-total=')) opts.workerTotal = parseInt(a.split('=')[1], 10);
        else if (a === '--build-index-only') opts.buildIndexOnly = true;
        else if (a === '--dry-run') opts.dryRun = true;
    }
    return opts;
}

async function shardWorkerDir(workerShard, r2, bucket, r2Prefix, dryRun) {
    const workerDir = path.join(BULK_OUTPUT, `worker-${workerShard}`);
    const allFiles = (await fs.readdir(workerDir)).filter(f => f.endsWith('.jsonl')).sort();
    console.log(`[SHARD] worker-${workerShard}: ${allFiles.length} chunk files`);

    const shardEntries = [];
    let totalRecords = 0;
    let buf = [];

    const flushShard = async (entities) => {
        if (entities.length === 0) return;
        const cids = entities.map(e => e.cid ?? 0).filter(Boolean);
        const minCid = cids.length ? Math.min(...cids) : totalRecords;
        const maxCid = cids.length ? Math.max(...cids) : totalRecords + entities.length;
        const raw = Buffer.from(entities.map(e => JSON.stringify(e)).join('\n') + '\n');
        const compressed = compressBuf(raw);
        const { id, r2Key } = buildShardKey(r2Prefix, minCid, maxCid);

        if (!dryRun && r2) {
            await uploadBuf(r2, bucket, r2Key, compressed, 'application/gzip');
        }

        const entry = {
            shard_id: id,
            cid_range: [minCid, maxCid],
            entity_count: entities.length,
            uncompressed_bytes: raw.length,
            compressed_bytes: compressed.length,
            compression_ratio: +(compressed.length / raw.length).toFixed(3),
            sha256_compressed: sha256hex(compressed),
            r2_key: r2Key,
        };
        shardEntries.push(entry);
        totalRecords += entities.length;
        console.log(`  ${id}: ${entities.length} records  ${(compressed.length / 1024).toFixed(1)} KB`);
    };

    for (const fname of allFiles) {
        const fpath = path.join(workerDir, fname);
        const rl = readline.createInterface({ input: createReadStream(fpath), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try { buf.push(JSON.parse(line)); } catch { continue; }
            if (buf.length >= SHARD_SIZE) {
                await flushShard(buf);
                buf = [];
            }
        }
    }
    if (buf.length > 0) await flushShard(buf);

    const manifest = {
        worker_shard: workerShard,
        run_month: r2Prefix.split('/').pop(),
        total_records: totalRecords,
        shard_count: shardEntries.length,
        shards: shardEntries,
        generated_at: new Date().toISOString(),
    };

    if (!dryRun && r2) {
        const key = await uploadWorkerManifest(r2, bucket, r2Prefix, workerShard, manifest);
        console.log(`[SHARD] worker-${workerShard} manifest → ${key}`);
    }

    console.log(`[SHARD] worker-${workerShard} done: ${totalRecords} records, ${shardEntries.length} shards`);
    return manifest;
}

async function buildGlobalIndex(r2, bucket, r2Prefix, workerTotal, dryRun) {
    console.log(`[SHARD] Building global index from ${workerTotal} worker manifests`);
    const allShards = [];
    let totalRecords = 0;
    let workersFailed = 0;

    for (let w = 0; w < workerTotal; w++) {
        const m = await downloadWorkerManifest(r2, bucket, r2Prefix, w);
        if (!m) { workersFailed++; continue; }
        allShards.push(...m.shards);
        totalRecords += m.total_records;
    }

    allShards.sort((a, b) => a.cid_range[0] - b.cid_range[0]);

    const index = {
        version: '1.0',
        run_month: r2Prefix.split('/').pop(),
        generated_at: new Date().toISOString(),
        total_records: totalRecords,
        shard_count: allShards.length,
        shard_size: SHARD_SIZE,
        format: 'jsonl.gz',
        workers_failed: workersFailed,
        shards: allShards,
    };

    if (!dryRun) {
        const key = await uploadGlobalIndex(r2, bucket, r2Prefix, index);
        console.log(`[SHARD] Global index → ${key} (${allShards.length} shards, ${totalRecords} records)`);
    } else {
        console.log(`[SHARD] --dry-run: index not uploaded (${allShards.length} shards, ${totalRecords} records)`);
    }
}

async function main() {
    const opts = parseArgs();
    const r2Prefix = `bulk/pubchem/${opts.runMonth}`;

    const { client, bucket, missing } = makeR2Client();
    if (missing.length > 0) {
        console.warn(`[SHARD] R2 not configured (missing: ${missing.join(', ')}) — dry-run forced`);
        opts.dryRun = true;
    }

    if (opts.buildIndexOnly) {
        if (!client && !opts.dryRun) { console.error('[SHARD] --build-index-only requires R2'); process.exit(1); }
        await buildGlobalIndex(client, bucket, r2Prefix, opts.workerTotal, opts.dryRun);
        return;
    }

    if (opts.workerShard === null) {
        console.error('[SHARD] Provide --worker-shard=N or --build-index-only');
        process.exit(1);
    }

    await shardWorkerDir(opts.workerShard, client, bucket, r2Prefix, opts.dryRun);
}

main().catch(err => { console.error('[SHARD] Fatal:', err); process.exit(1); });
