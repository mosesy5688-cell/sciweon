/**
 * Target Linker — Phase 1.4-pre.1b orchestrator (cycle 23).
 *
 * Builds the first-class Sciweon target entity by deduplicating across:
 *   - Open Targets (primary, R2 target-enriched.jsonl.zst)
 *   - ChEMBL bioactivity.target (secondary, local bioactivities.jsonl)
 *
 * Dedupe key: UniProt canonical accession (post defect-8 truncation
 * roll-up). OT records win on conflict; bioactivity-only targets enter
 * as skeleton records. Pure functions extracted to lib/target-linker-
 * helpers.js so vitest can import without main() side-effects.
 *
 * Output: output/linked/targets.jsonl consumed by Phase 1.4 SID stamping.
 */

import { writeFileSync, createReadStream } from 'fs';
import readline from 'readline';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { spawnSync } from 'child_process';
import {
    buildOtTargetMap, mergeBioactivityTargets, parseJsonlBuffer,
} from './lib/target-linker-helpers.js';

const TARGETS_OUTPUT = 'output/linked/targets.jsonl';
const BIOACTIVITIES_PATH = 'output/linked/bioactivities.jsonl';
const TARGET_CURSOR_KEY = 'state/open-targets-target-cursor.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[TARGET-LINKER] missing env: ${missing.join(', ')}`);
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

function zstdCliDecompress(input) {
    const result = spawnSync('zstd', ['-d', '--stdout', '--quiet'], { input, maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw new Error(`[TARGET-LINKER] zstd CLI spawn failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`[TARGET-LINKER] zstd CLI exit ${result.status}: ${result.stderr?.toString()}`);
    return result.stdout;
}

async function readBioactivities(filePath) {
    const records = [];
    const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { /* skip */ }
    }
    return records;
}

async function main() {
    const startMs = Date.now();
    const nowIso = new Date().toISOString();
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    console.log('[TARGET-LINKER] Phase 1.4-pre.1b target linker | merging OT + bioactivity sources');
    const cursorBuf = await getR2Object(client, bucket, TARGET_CURSOR_KEY);
    const cursor = JSON.parse(cursorBuf.toString('utf-8'));
    console.log(`[TARGET-LINKER] OT target cursor: release=${cursor.release_version} record_count=${cursor.record_count} schema=${cursor.schema_version}`);

    const otCompressed = await getR2Object(client, bucket, cursor.r2_key);
    const otRecords = parseJsonlBuffer(zstdCliDecompress(otCompressed));
    console.log(`[TARGET-LINKER] Loaded ${otRecords.length} OT target records from ${cursor.r2_key}`);

    const { targets, skippedNoUniprot: otSkipped } = buildOtTargetMap(otRecords, nowIso);
    console.log(`[TARGET-LINKER] OT primary load: ${targets.size} unique UniProt canonical (skipped ${otSkipped} OT records without UniProt)`);

    const bioRecords = await readBioactivities(BIOACTIVITIES_PATH).catch(() => []);
    console.log(`[TARGET-LINKER] Loaded ${bioRecords.length} bioactivity records`);
    const { added, appendedToExisting, skippedNoUniprot: bioSkipped } = mergeBioactivityTargets(targets, bioRecords, nowIso);
    console.log(`[TARGET-LINKER] Bioactivity merge: +${added} new UniProt targets, ${appendedToExisting} OT targets gained chembl provenance, skipped ${bioSkipped} bioactivity records without UniProt`);

    const output = Array.from(targets.values()).map(t => JSON.stringify(t)).join('\n') + '\n';
    writeFileSync(TARGETS_OUTPUT, output, 'utf-8');
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    console.log(`[TARGET-LINKER] Wrote ${TARGETS_OUTPUT} with ${targets.size} unique targets (${Buffer.byteLength(output)}B) in ${elapsed}s`);
    console.log(`[TARGET-LINKER] === SUMMARY ===`);
    console.log(`  total_targets:        ${targets.size}`);
    console.log(`  from_open_targets:    ${targets.size - added}`);
    console.log(`  from_bioactivity:     ${added}`);
    console.log(`  cross_source_targets: ${appendedToExisting}`);
    console.log('[TARGET-LINKER] SUCCESS');
}

main().catch(err => {
    console.error(`[TARGET-LINKER] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
