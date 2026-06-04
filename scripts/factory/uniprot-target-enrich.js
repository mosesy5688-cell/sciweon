/**
 * UniProt SwissProt -> target reference accession-enrich orchestrator (PR-UNIPROT-2b).
 *
 * F3 (Aggregate) stage, AFTER target-linker on the same output/linked/targets.jsonl.
 * Reads the UniProt FULL-corpus bulk (state/uniprot-bulk-cursor.json -> r2_key =
 * processed/bulk/uniprot/<release>/sprot.jsonl.zst, 574,627 all-organism records,
 * CC BY 4.0), STREAM-FILTERS it against the ~19k target accessions, builds the
 * accession index, and enriches targets.jsonl IN PLACE: all-organism organism
 * (evidence-derived, replacing the PR-UNIPROT-2a-nulled hardcode) + additive UniProt
 * fields + cc-by-4.0 provenance.
 *
 * OPTION A: targets.jsonl KEEPS drug-target semantics (NOT inflated to 574k). The full
 * all-organism protein reference is a separate artifact -> PR-UNIPROT-3.
 *
 * STREAMING-FILTER (lib/uniprot-stream-decompress.js): build the target accession Set
 * FIRST, then TRULY stream the zstd decompression -- spawn `zstd -d --stdout` and pipe
 * its stdout through readline, parsing ONE LINE AT A TIME and RETAINING only records
 * whose primary/secondary accession hits the Set. The ~1.19GB decompressed corpus is
 * NEVER materialized (was a spawnSync whole-buffer decompress, maxBuffer=1GB -> ENOBUFS
 * on the 1.19GB bulk, aborting the daily F3 cascade). The cursor record_count guard
 * counts records SEEN (parsed), NOT retained.
 *
 * NO SILENT DROP ([[cross_cycle_silent_data_loss]]): records_seen != cursor.record_count
 * HARD-FAILS; matched + unmatched_target === targets.length is asserted; every
 * unmatched/colliding record is a telemetry counter, never silently discarded.
 * DETERMINISM: nowIso captured once; pure helpers stable-sort every collection.
 */

import { readFileSync, writeFileSync } from 'fs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
    buildTargetAccessionSet, uniprotRecordHitsTargets, buildUniprotAccessionIndex,
    enrichTargetsWithUniprot,
} from './lib/uniprot-target-enrich-helpers.js';
import { streamDecompressFilter } from './lib/uniprot-stream-decompress.js';

const LABEL = 'UNIPROT-TARGET-ENRICH';
const CURSOR_KEY = 'state/uniprot-bulk-cursor.json';
const TARGETS_PATH = 'output/linked/targets.jsonl';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[${LABEL}] missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto', endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function getR2Object(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return streamToBuffer(res.Body);
}

/** Read JSONL targets (one record per line). */
function readTargets(path) {
    const records = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        records.push(JSON.parse(t));
    }
    return records;
}

async function main() {
    const startMs = Date.now();
    const nowIso = new Date().toISOString();
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    console.log(`[${LABEL}] PR-UNIPROT-2b UniProt accession-enrich | R2 bulk -> ${TARGETS_PATH}`);
    const cursorBuf = await getR2Object(client, bucket, CURSOR_KEY);
    const cursor = JSON.parse(cursorBuf.toString('utf-8'));
    console.log(`[${LABEL}] cursor: release=${cursor.release_version} record_count=${cursor.record_count} r2_key=${cursor.r2_key} schema=${cursor.schema_version}`);
    if (typeof cursor.record_count !== 'number' || !cursor.r2_key) {
        throw new Error(`[${LABEL}] cursor malformed: record_count=${cursor.record_count} r2_key=${cursor.r2_key}`);
    }

    const targets = readTargets(TARGETS_PATH);
    console.log(`[${LABEL}] Loaded ${targets.length} targets from ${TARGETS_PATH}`);
    const targetAccSet = buildTargetAccessionSet(targets);
    console.log(`[${LABEL}] Built target accession Set: ${targetAccSet.size} unique sanitized accessions`);

    // STREAMING decompress+filter: zstd -d --stdout piped through readline, parsed
    // line-by-line. The ~64MB compressed buffer is held; the ~1.19GB DECOMPRESSED
    // corpus is NEVER materialized -- memory is bounded to the ~19k retained records.
    // (Was a spawnSync whole-buffer decompress with maxBuffer=1GB -> ENOBUFS on the
    // 1.19GB bulk, aborting the daily F3 cascade.)
    const compressed = await getR2Object(client, bucket, cursor.r2_key);
    const { retained, recordsSeen, unmatchedUniprot, headerSkipped } =
        await streamDecompressFilter(compressed, (rec) => uniprotRecordHitsTargets(rec, targetAccSet), LABEL);
    console.log(`[${LABEL}] Stream-filtered bulk: seen=${recordsSeen} retained=${retained.length} unmatched_uniprot=${unmatchedUniprot} (header lines skipped=${headerSkipped})`);

    // NO SILENT DROP: records SEEN (parsed) must equal the cursor's record-of-truth.
    // Mismatch = artifact/cursor drift or a truncated decompress -> HALT LOUD.
    if (recordsSeen !== cursor.record_count) {
        throw new Error(`[${LABEL}] HALT: records_seen=${recordsSeen} != cursor.record_count=${cursor.record_count} (artifact/cursor drift or truncated decompress -- per [[cross_cycle_silent_data_loss]])`);
    }

    const { index, multi_accession_collision } = buildUniprotAccessionIndex(retained);
    console.log(`[${LABEL}] Built accession index: ${index.size} keys, multi_accession_collision=${multi_accession_collision}`);

    const { stats } = enrichTargetsWithUniprot(targets, index, { nowIso, release: cursor.release_version });

    // No silent drop invariant: every target is accounted (matched OR unmatched).
    if (stats.matched + stats.unmatched_target !== targets.length) {
        throw new Error(`[${LABEL}] HALT: matched(${stats.matched}) + unmatched_target(${stats.unmatched_target}) != targets.length(${targets.length})`);
    }

    const sampleUnmatched = targets
        .filter(t => !t.provenance.sources.some(s => s.source === 'uniprot_swissprot'))
        .slice(0, 10)
        .map(t => t.uniprot_accession);

    const output = targets.map(t => JSON.stringify(t)).join('\n') + (targets.length > 0 ? '\n' : '');
    writeFileSync(TARGETS_PATH, output, 'utf-8');

    const elapsed = Math.round((Date.now() - startMs) / 1000);
    console.log(`[${LABEL}] Wrote ${TARGETS_PATH} (${targets.length} targets, ${Buffer.byteLength(output)}B) in ${elapsed}s`);
    console.log(`[${LABEL}] === TELEMETRY ===`);
    console.log(`  release:                            ${cursor.release_version}`);
    console.log(`  records_seen:                       ${recordsSeen}`);
    console.log(`  matched:                            ${stats.matched}`);
    console.log(`  unmatched_target:                   ${stats.unmatched_target}`);
    console.log(`  unmatched_uniprot:                  ${unmatchedUniprot}`);
    console.log(`  multi_accession_collision:          ${multi_accession_collision}`);
    console.log(`  targets_with_null_organism_after_join: ${stats.targets_with_null_organism_after_join}`);
    console.log(`  unmatched_target_sample:            ${JSON.stringify(sampleUnmatched)}`);
    console.log(`[${LABEL}] SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
