/**
 * SNOMED Concept Linker -- PR-UMLS-3 F3 placement orchestrator.
 *
 * Reads the R2 SNOMED bulk artifact (internal/processed/bulk/umls/<release>/
 * snomed-concepts.jsonl.zst per PR-UMLS-3), decompresses (zstd CLI), parses each JSONL
 * line SKIPPING the leading `#`-prefixed license header + blank lines, and writes a
 * pass-through copy to output/linked/snomed-concepts.jsonl for the PR-UMLS-3 SID SNOMED
 * stamper to consume.
 *
 * LICENSE NOTE (RULING 2): the SOURCE is read from the `internal/` R2 prefix (the FULL
 * STR+CODE+CUI artifact, never publicly servable). The local working copy
 * output/linked/snomed-concepts.jsonl is ALSO the FULL internal artifact -- it is stamped
 * in place, cross-linked, and then PROJECTED to a public {sid_s,sid_c}-only file
 * (snomed-concepts-public.jsonl) by the F3 public builder. The full file is added to
 * AGGREGATED_FILES (internal F3->F4 round-trip) but DELIBERATELY OMITTED from SNAPSHOT_FILES
 * (RULING 1: no SNOMED proprietary content in the public snapshot).
 *
 * Records already carry the SID-S anchor fields (anchor_payload = `SNOMEDCT_US:<CODE>`,
 * canonicalization_version) from the harvest lib; this linker does NOT transform them.
 *
 * DECISION (locked): assert records.length === cursor.record_count. The cursor (written by
 * umls-snomed-harvest.js) is the count-of-record truth; on mismatch FAIL LOUD per
 * [[cross_cycle_silent_data_loss]] zero-tolerance.
 */

import { writeFileSync } from 'fs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { streamDecompressForEach } from './lib/stream-decompress-foreach.js';

const LABEL = 'SNOMED-LINKER';
const SNOMED_CURSOR_KEY = 'state/umls-snomed-bulk-cursor.json';
const SNOMED_OUTPUT = 'output/linked/snomed-concepts.jsonl';
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

/**
 * STREAMING decompress + parse (PR fix: was a spawnSync whole-buffer decompress with
 * maxBuffer=1GB -- the same ENOBUFS class that broke the cascade in
 * uniprot-target-enrich). The artifact's FIRST line is a `#`-prefixed license header
 * (umls-snomed-harvest.js); skip it + blank lines. Every remaining non-empty line is a
 * concept record (pass-through, no transform). Malformed lines are COUNTED (not thrown
 * here) so the caller preserves its exact "throw iff parseErrors > 0" contract.
 */
async function parseSnomedJsonl(compressed) {
    const records = [];
    const { recordsSeen, headerSkipped, malformed } = await streamDecompressForEach(
        compressed, (rec) => { records.push(rec); },
        { label: LABEL, hasHeader: true, onMalformed: 'count' });
    return { records, parseErrors: malformed, headerSkipped, recordsSeen };
}

async function main() {
    const startMs = Date.now();
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    console.log(`[${LABEL}] PR-UMLS-3 SNOMED F3 placement | R2 (internal/) -> ${SNOMED_OUTPUT}`);
    const cursorBuf = await getR2Object(client, bucket, SNOMED_CURSOR_KEY);
    const cursor = JSON.parse(cursorBuf.toString('utf-8'));
    console.log(`[${LABEL}] cursor: release=${cursor.release} record_count=${cursor.record_count} r2_data_key=${cursor.r2_data_key}`);

    if (typeof cursor.record_count !== 'number' || !cursor.r2_data_key) {
        throw new Error(`[${LABEL}] cursor malformed: record_count=${cursor.record_count} r2_data_key=${cursor.r2_data_key}`);
    }

    const compressed = await getR2Object(client, bucket, cursor.r2_data_key);
    const { records, parseErrors, headerSkipped } = await parseSnomedJsonl(compressed);
    if (parseErrors > 0) {
        // A JSON parse error is silent data loss -- the cursor count would no longer
        // match. Fail loud rather than emit a short file.
        throw new Error(`[${LABEL}] ${parseErrors} JSON parse errors in ${cursor.r2_data_key} -- aborting (no silent drop)`);
    }
    console.log(`[${LABEL}] Loaded ${records.length} SNOMED concepts (skipped ${headerSkipped} header line) from ${cursor.r2_data_key}`);

    // cursor.record_count is truth. Mismatch means upstream artifact/cursor drift (or a
    // truncated decompress) -> HALT LOUD.
    if (records.length !== cursor.record_count) {
        throw new Error(`[${LABEL}] HALT: parsed records=${records.length} != cursor.record_count=${cursor.record_count} (artifact/cursor drift or truncated decompress -- per [[cross_cycle_silent_data_loss]])`);
    }

    // Defect-15 lesson: records.map(...).join('\n') is stack-safe at any size.
    const output = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
    writeFileSync(SNOMED_OUTPUT, output, 'utf-8');

    const elapsed = Math.round((Date.now() - startMs) / 1000);
    console.log(`[${LABEL}] Wrote ${SNOMED_OUTPUT} (${records.length} concepts, ${Buffer.byteLength(output)}B) in ${elapsed}s`);
    console.log(`[${LABEL}] === SUMMARY ===`);
    console.log(`  release:              ${cursor.release}`);
    console.log(`  cursor_record_count:  ${cursor.record_count}`);
    console.log(`  parsed_records:       ${records.length}`);
    console.log(`  header_lines_skipped: ${headerSkipped}`);
    console.log(`[${LABEL}] SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
