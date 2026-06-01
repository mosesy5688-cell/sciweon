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
import readline from 'readline';
import { parseSdfStream } from './lib/sdf-parser.js';
import { mapPubchemRecord } from './lib/pubchem-sdf-mapper.js';
import {
    downloadAndConsume, NotFoundError, HttpError, StreamRetryError,
    DEFAULT_MAX_ATTEMPTS,
} from './lib/stream-fetch-retry.js';

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

/**
 * Consume ONE decompressed attempt: parse SDF, write mapped records to a fresh
 * temp file (truncated each attempt so a retried download never leaks the
 * previous attempt's half-written records). Returns counts for this attempt.
 * A network drop mid-stream rejects the readline iteration -> rejects the
 * pipeline -> downloadAndConsume retries; only a CLEAN finish reaches rename.
 */
async function consumeAttempt(decompressed, partialPath, chunkName, ts) {
    const fh = await fs.open(partialPath, 'w'); // 'w' truncates -> determinism: byte 0 each attempt
    const rl = readline.createInterface({ input: decompressed, crlfDelay: Infinity });
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
    } finally {
        await fh.close();
    }
    return { parsed, mapped };
}

async function processChunk(chunkName, outputDir, workerStats) {
    const url = `${PUBCHEM_FTP_BASE}/${chunkName}`;
    const localOut = path.join(outputDir, chunkName.replace('.sdf.gz', '.jsonl'));
    const partialOut = `${localOut}.partial`;
    console.log(`[BULK]   chunk ${chunkName} -> ${localOut}`);

    const ts = new Date().toISOString();
    let last = { parsed: 0, mapped: 0 };

    try {
        const { attempts } = await downloadAndConsume(url, {
            consume: async (decompressed) => {
                // Re-parse from byte 0 each attempt; truncate the temp file first.
                last = await consumeAttempt(decompressed, partialOut, chunkName, ts);
            },
            onRetry: (attempt, err) => {
                console.error(`[BULK]     ${chunkName}: transient drop on attempt ${attempt} (${err.code || err.name || err.message}) -- retrying`);
            },
        });
        // CLEAN full-stream completion: atomic temp-then-rename.
        await fs.rename(partialOut, localOut);
        workerStats.chunks_done.push({ chunk: chunkName, parsed: last.parsed, mapped: last.mapped, attempts });
        console.log(`[BULK]     ${chunkName}: ${last.parsed} parsed, ${last.mapped} mapped (done, ${attempts} attempt(s))`);
        return { parsed: last.parsed, mapped: last.mapped };
    } catch (err) {
        await fs.rm(partialOut, { force: true }); // never leave a half-written temp for the sharder
        if (err instanceof NotFoundError) {
            console.log(`[BULK]     skip 404 (chunk does not exist in this PubChem version)`);
            return { parsed: 0, mapped: 0 };
        }
        if (err instanceof StreamRetryError) {
            // Exhausted retries on a transient drop: LOUD unrecoverable record.
            console.error(`[BULK]     UNRECOVERABLE ${chunkName}: ${err.attempts} attempts exhausted, last=${err.errorClass}`);
            workerStats.unrecoverable_chunks.push({
                chunk: chunkName, attempts: err.attempts, last_error_class: err.errorClass,
                error: err.message,
            });
            return { parsed: 0, mapped: 0 };
        }
        // Non-retryable HTTP (other 4xx) or a parser error: keep chunks_failed semantics.
        const tag = err instanceof HttpError ? `HTTP ${err.status}` : `parse: ${err.message}`;
        workerStats.chunks_failed.push({ chunk: chunkName, error: tag });
        return { parsed: 0, mapped: 0 };
    }
}

/**
 * Worker exit-policy decision (pure, unit-testable -- do NOT call process.exit
 * here). LOCKED policy: finish ALL sibling chunks, then exit non-zero if ANY
 * chunk is unrecoverable (so the leg is visibly failed + re-runnable via
 * --start-chunk-index), AND keep the legacy "all chunks failed -> exit 1".
 */
function decideExitCode(stats) {
    if ((stats.unrecoverable_chunks?.length ?? 0) > 0) return 1;
    if ((stats.chunks_failed?.length ?? 0) > 0 && (stats.chunks_done?.length ?? 0) === 0) return 1;
    return 0;
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
        unrecoverable_chunks: [],
        complete: false,
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
    // `complete` is the no-silent-partial-index gate: false iff any chunk was
    // unrecoverable after exhausting retries. The fan-in (build-index-only)
    // fails the global index build when ANY worker manifest is complete:false.
    workerStats.complete = workerStats.unrecoverable_chunks.length === 0;

    // Write the manifest FIRST (so partial work + the loud unrecoverable record
    // reach R2) before deciding the exit code.
    const manifestPath = path.join(outputDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(workerStats, null, 2));

    console.log(`\n[BULK] === Worker ${opts.matrixShard + 1}/${opts.matrixTotal} Summary ===`);
    console.log(`  Elapsed:           ${workerStats.elapsed_sec}s (${(workerStats.elapsed_sec / 60).toFixed(1)} min)`);
    console.log(`  Chunks processed:  ${workerStats.chunks_done.length}/${myChunks.length}`);
    console.log(`  Chunks failed:     ${workerStats.chunks_failed.length}`);
    console.log(`  Unrecoverable:     ${workerStats.unrecoverable_chunks.length}`);
    console.log(`  Complete:          ${workerStats.complete}`);
    console.log(`  Total parsed:      ${workerStats.total_parsed}`);
    console.log(`  Total mapped:      ${workerStats.total_mapped}`);
    console.log(`  Manifest:          ${manifestPath}`);

    const exitCode = decideExitCode(workerStats);
    if (exitCode !== 0) {
        if (workerStats.unrecoverable_chunks.length > 0) {
            console.error(`[BULK] ${workerStats.unrecoverable_chunks.length} unrecoverable chunk(s) -- worker incomplete; exit ${exitCode} (re-run via --start-chunk-index)`);
        } else {
            console.error('[BULK] ALL chunks failed for this worker -- exit 1');
        }
        process.exit(exitCode);
    }
}

// Only auto-run as a CLI script (node bulk-pubchem-harvest.js ...), not on import
// (tests import the pure exports without triggering a real harvest).
import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => { console.error('[BULK] Fatal:', err); process.exit(1); });
}

export { generateChunkFilenames, partitionForWorker, decideExitCode };
