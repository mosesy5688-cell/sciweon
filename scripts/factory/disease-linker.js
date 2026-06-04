/**
 * Disease Linker — Phase 1.6b-pre.1b orchestrator (cycle 23).
 *
 * Reads R2 OT disease bulk artifact (processed/bulk/open-targets/<release>/
 * disease-enriched.jsonl.zst per PR-SID-1.6b-pre.1a), parses each raw
 * disease_id via per-namespace multi-canon protocol (Plan A1 lock 2026-05-25),
 * dedupes by Sciweon id, writes output/linked/diseases.jsonl consumed by
 * Phase 1.6b SID stamping.
 *
 * Pure-function helpers live in lib/disease-linker-helpers.js (testable);
 * this orchestrator owns R2 IO + main() side-effects only.
 *
 * Per [[cross_cycle_silent_data_loss]] zero-tolerance: telemetry reports
 * unparseable_disease_id + dedup_collision counts explicitly (Plan-A1
 * transparency — NOT silent drop).
 */

import { writeFileSync } from 'fs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
    LINKER_LABEL, buildDiseaseRecord, dedupeBySciweonId, buildNamespaceCounts,
} from './lib/disease-linker-helpers.js';
import { streamDecompressForEach } from './lib/stream-decompress-foreach.js';

const DISEASE_CURSOR_KEY = 'state/open-targets-disease-cursor.json';
const DISEASES_OUTPUT = 'output/linked/diseases.jsonl';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[${LINKER_LABEL}] missing env: ${missing.join(', ')}`);
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

async function main() {
    const startMs = Date.now();
    const nowIso = new Date().toISOString();
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    console.log(`[${LINKER_LABEL}] Phase 1.6b-pre.1b disease linker | per-namespace multi-canon (Plan A1)`);
    const cursorBuf = await getR2Object(client, bucket, DISEASE_CURSOR_KEY);
    const cursor = JSON.parse(cursorBuf.toString('utf-8'));
    console.log(`[${LINKER_LABEL}] OT disease cursor: release=${cursor.release_version} record_count=${cursor.record_count} schema=${cursor.schema_version}`);

    // STREAMING decompress (PR fix: was a spawnSync whole-buffer decompress with
    // maxBuffer=256MB -- the same ENOBUFS class that broke the cascade in
    // uniprot-target-enrich). The OT disease bulk has NO `#` header (hasHeader:false);
    // malformed lines are skip-and-WARN (onMalformed:'count', preserving the prior
    // contract -- NOT a hard-fail). buildDiseaseRecord runs per record in onRecord, so
    // the decompressed corpus is never materialized; only `built` is retained.
    const compressed = await getR2Object(client, bucket, cursor.r2_key);
    const built = [];
    const skipCounts = { missing_disease_id: 0, unparseable_disease_id: 0 };
    const { recordsSeen: totalOtRows, malformed: parseErrors } = await streamDecompressForEach(
        compressed, (row) => {
            const r = buildDiseaseRecord(row, nowIso);
            if (r.skip) { skipCounts[r.skip] = (skipCounts[r.skip] || 0) + 1; return; }
            built.push(r.record);
        },
        { label: LINKER_LABEL, hasHeader: false, onMalformed: 'count' });
    if (parseErrors > 0) console.warn(`[${LINKER_LABEL}] ${parseErrors} JSON parse errors skipped`);
    console.log(`[${LINKER_LABEL}] Loaded ${totalOtRows} OT disease rows from ${cursor.r2_key}`);

    const { deduped, duplicates } = dedupeBySciweonId(built);
    const namespaceCounts = buildNamespaceCounts(deduped);

    // Defect-15 lesson: records.map(...).join('\n') is stack-safe at any size
    // (join() does NOT use spread on the argument stack).
    const output = deduped.map(r => JSON.stringify(r)).join('\n') + (deduped.length > 0 ? '\n' : '');
    writeFileSync(DISEASES_OUTPUT, output, 'utf-8');

    const elapsed = Math.round((Date.now() - startMs) / 1000);
    console.log(`[${LINKER_LABEL}] Wrote ${DISEASES_OUTPUT} (${deduped.length} diseases, ${Buffer.byteLength(output)}B) in ${elapsed}s`);
    console.log(`[${LINKER_LABEL}] === SUMMARY ===`);
    console.log(`  total_ot_rows:            ${totalOtRows}`);
    console.log(`  stamping_eligible:        ${deduped.length}`);
    console.log(`  skip_missing_disease_id:  ${skipCounts.missing_disease_id}`);
    console.log(`  skip_unparseable_id:      ${skipCounts.unparseable_disease_id}`);
    console.log(`  dedup_collisions:         ${duplicates}`);
    console.log(`  per_namespace_counts:     ${JSON.stringify(namespaceCounts)}`);
    console.log(`[${LINKER_LABEL}] SUCCESS`);
}

main().catch(err => {
    console.error(`[${LINKER_LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
