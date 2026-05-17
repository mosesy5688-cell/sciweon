/**
 * PubChem Bulk Harvest Orchestrator — V0.6 (Sprint 2 B.2)
 *
 * One-shot harvest of full PubChem CURRENT-Full SDF dump (250 chunk files,
 * ~50GB compressed, ~111M compounds). Designed for GHA matrix (8 workers
 * parallel; each worker processes ~31 SDF files = ~6GB compressed input).
 *
 * Per §8 + §10 architecture:
 *   - This script outputs LOCAL files only (./output/bulk/<worker>/...)
 *   - Sprint 2 B.3 will add R2 sharded upload (1000 CIDs/shard) + index.json
 *   - Sprint 2 B.4 will add Worker dual-tier API logic
 *
 * Matrix split (deterministic):
 *   worker N of M total processes chunks where (chunk_index % M === N).
 *   8-way matrix → each worker handles ~31 chunks → ~14M compounds.
 *
 * Inputs (env / args):
 *   --matrix-shard=N         (0-indexed worker ID)
 *   --matrix-total=M         (total worker count)
 *   --chunk-limit=K          (optional: only process first K chunks of this worker's slice; for testing)
 *   --start-chunk-index=I    (optional: skip first I chunks of this worker's slice; for resumable runs)
 *
 * Outputs:
 *   output/bulk/worker-{N}/<chunk-filename>.jsonl    (one compound per line, mapped to Sciweon schema)
 *   output/bulk/worker-{N}/manifest.json             (worker run summary: chunk-count, parsed, failed, etc.)
 *
 * Failure handling:
 *   Per-chunk: log + continue (don't halt entire worker on one bad SDF).
 *   Per-record: log + skip (rejected by mapPubchemRecord if missing CID/InChIKey).
 *   End-of-worker: write manifest with success/fail summary.
 *
 * Note: PubChem FTP HTTPS mirror is the public download endpoint. We
 * intentionally do NOT parse the directory listing — chunk file names
 * follow deterministic pattern `Compound_{start_cid:09d}_{end_cid:09d}.sdf.gz`
 * which we generate locally.
 */

import fs from 'fs/promises';
import path from 'path';
import { createGunzip } from 'zlib';
import readline from 'readline';
import { Readable } from 'stream';
import { parseSdfStream } from './lib/sdf-parser.js';
import { mapPubchemRecord } from './lib/pubchem-sdf-mapper.js';

const PUBCHEM_FTP_BASE = 'https://ftp.ncbi.nlm.nih.gov/pubchem/Compound/CURRENT-Full/SDF';
const CHUNK_SIZE_CIDS = 500_000;
const TOTAL_PUBCHEM_CIDS = 125_000_000; // ~125M as of 2026 (loose upper bound)
const OUTPUT_BASE = './output/bulk';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { matrixShard: 0, matrixTotal: 1, chunkLimit: null, startChunkIndex: 0 };
    for (const arg of args) {
        if (arg.startsWith('--matrix-shard=')) opts.matrixShard = parseInt(arg.split('=')[1], 10);
        else if (arg.startsWith('--matrix-total=')) opts.matrixTotal = parseInt(arg.split('=')[1], 10);
        else if (arg.startsWith('--chunk-limit=')) opts.chunkLimit = parseInt(arg.split('=')[1], 10);
        else if (arg.startsWith('--start-chunk-index=')) opts.startChunkIndex = parseInt(arg.split('=')[1], 10);
    }
    if (!Number.isInteger(opts.matrixShard) || opts.matrixShard < 0) throw new Error('--matrix-shard must be a non-negative integer');
    if (!Number.isInteger(opts.matrixTotal) || opts.matrixTotal < 1) throw new Error('--matrix-total must be >= 1');
    if (opts.matrixShard >= opts.matrixTotal) throw new Error(`--matrix-shard ${opts.matrixShard} must be < --matrix-total ${opts.matrixTotal}`);
    return opts;
}

function pad9(n) { return String(n).padStart(9, '0'); }

function generateChunkFilenames() {
    const filenames = [];
    for (let startCid = 1; startCid <= TOTAL_PUBCHEM_CIDS; startCid += CHUNK_SIZE_CIDS) {
        const endCid = startCid + CHUNK_SIZE_CIDS - 1;
        filenames.push(`Compound_${pad9(startCid)}_${pad9(endCid)}.sdf.gz`);
    }
    return filenames;
}

function partitionForWorker(allChunks, shard, total) {
    return allChunks.filter((_, idx) => (idx % total) === shard);
}

async function processChunk(chunkName, outputDir, workerStats) {
    const url = `${PUBCHEM_FTP_BASE}/${chunkName}`;
    const localOut = path.join(outputDir, chunkName.replace('.sdf.gz', '.jsonl'));
    console.log(`[BULK]   chunk ${chunkName} → ${localOut}`);

    let res;
    try {
        res = await fetch(url);
    } catch (err) {
        workerStats.chunks_failed.push({ chunk: chunkName, error: `network: ${err.message}` });
        return { parsed: 0, mapped: 0 };
    }
    if (!res.ok) {
        if (res.status === 404) {
            console.log(`[BULK]     skip 404 (chunk does not exist in this PubChem version)`);
            return { parsed: 0, mapped: 0 };
        }
        workerStats.chunks_failed.push({ chunk: chunkName, error: `HTTP ${res.status}` });
        return { parsed: 0, mapped: 0 };
    }
    if (!res.body) {
        workerStats.chunks_failed.push({ chunk: chunkName, error: 'no body' });
        return { parsed: 0, mapped: 0 };
    }

    const gunzip = createGunzip();
    const nodeBody = Readable.fromWeb(res.body);
    const decompressed = nodeBody.pipe(gunzip);
    const rl = readline.createInterface({ input: decompressed, crlfDelay: Infinity });

    const fh = await fs.open(localOut, 'w');
    const ts = new Date().toISOString();
    let parsed = 0;
    let mapped = 0;

    try {
        for await (const rec of parseSdfStream(rl)) {
            parsed++;
            const compound = mapPubchemRecord(rec, { timestamp: ts });
            if (compound) {
                await fh.write(JSON.stringify(compound) + '\n');
                mapped++;
            }
            if (parsed % 10_000 === 0) {
                console.log(`[BULK]     ${chunkName}: ${parsed} parsed, ${mapped} mapped`);
            }
        }
    } catch (err) {
        workerStats.chunks_failed.push({ chunk: chunkName, error: `parse: ${err.message}` });
    } finally {
        await fh.close();
    }

    workerStats.chunks_done.push({ chunk: chunkName, parsed, mapped });
    console.log(`[BULK]     ${chunkName}: ${parsed} parsed, ${mapped} mapped (done)`);
    return { parsed, mapped };
}

async function main() {
    const opts = parseArgs();
    const startTime = Date.now();
    console.log(`[BULK] V0.6 Sprint 2 B.2 — worker ${opts.matrixShard + 1}/${opts.matrixTotal}`);

    const outputDir = path.join(OUTPUT_BASE, `worker-${opts.matrixShard}`);
    await fs.mkdir(outputDir, { recursive: true });

    const allChunks = generateChunkFilenames();
    const myChunks = partitionForWorker(allChunks, opts.matrixShard, opts.matrixTotal);
    console.log(`[BULK] Total chunks: ${allChunks.length}, this worker's slice: ${myChunks.length}`);

    const workerStats = {
        worker_shard: opts.matrixShard,
        worker_total: opts.matrixTotal,
        start_time: new Date(startTime).toISOString(),
        chunks_assigned: myChunks.length,
        chunks_done: [],
        chunks_failed: [],
        total_parsed: 0,
        total_mapped: 0,
    };

    let processed = 0;
    for (let i = opts.startChunkIndex; i < myChunks.length; i++) {
        if (opts.chunkLimit !== null && processed >= opts.chunkLimit) break;
        const chunkName = myChunks[i];
        const { parsed, mapped } = await processChunk(chunkName, outputDir, workerStats);
        workerStats.total_parsed += parsed;
        workerStats.total_mapped += mapped;
        processed++;
    }

    workerStats.end_time = new Date().toISOString();
    workerStats.elapsed_sec = Math.round((Date.now() - startTime) / 1000);

    const manifestPath = path.join(outputDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(workerStats, null, 2));

    console.log(`\n[BULK] === Worker ${opts.matrixShard + 1}/${opts.matrixTotal} Summary ===`);
    console.log(`  Elapsed:           ${workerStats.elapsed_sec}s (${(workerStats.elapsed_sec / 60).toFixed(1)} min)`);
    console.log(`  Chunks processed:  ${workerStats.chunks_done.length}/${myChunks.length}`);
    console.log(`  Chunks failed:     ${workerStats.chunks_failed.length}`);
    console.log(`  Total parsed:      ${workerStats.total_parsed}`);
    console.log(`  Total mapped:      ${workerStats.total_mapped}`);
    console.log(`  Manifest:          ${manifestPath}`);

    if (workerStats.chunks_failed.length > 0 && workerStats.chunks_done.length === 0) {
        console.error('[BULK] ALL chunks failed for this worker — exit 1');
        process.exit(1);
    }
}

main().catch(err => { console.error('[BULK] Fatal:', err); process.exit(1); });

export { generateChunkFilenames, partitionForWorker };
