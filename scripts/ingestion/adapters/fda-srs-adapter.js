/**
 * FDA SRS adapter (Phase 1.8 PR-FDA-SRS-2).
 *
 * BULK FILE adapter (not per-record API). Downloads the latest published
 * unii-lookup.jsonl.zst from R2, decompresses streaming, builds an
 * in-memory Map<inchi_key, { unii, preferred_name, cas_rn }>. Adapter is
 * O(1) Map lookup at enrichOne time; no rate limit / no sleepMsBetween.
 *
 * Architect-locked rails active here:
 *   Rail 5 -- normalizeInChIKey imported from harvester (SSoT shared)
 *   Rail 9 -- drop bucket telemetry: empty_inchikey (legit non-small-mol)
 *             vs malformed_inchikey (real dirty data); 0.5% warn threshold
 *   Rail 10a -- lookupByInchiKey returns SHARED REFERENCE; no deep clone;
 *             defends 30MB heap ceiling against GC thrash on 5000-record
 *             chunk rotation in drain loop
 */

import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { normalizeInChIKey } from '../../factory/fda-srs-harvest.js';

const CURSOR_KEY = 'state/fda-srs-cursor.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export { normalizeInChIKey };

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[FDA-SRS-ADAPTER] missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto', endpoint: process.env.R2_ENDPOINT,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

function zstdDecompressFile(inputPath, outputPath) {
    const result = spawnSync('zstd', ['-d', '-f', '-o', outputPath, inputPath]);
    if (result.error) throw new Error(`[FDA-SRS-ADAPTER] zstd spawn: ${result.error.message}`);
    if (result.status !== 0) {
        throw new Error(`[FDA-SRS-ADAPTER] zstd exit ${result.status}: ${result.stderr?.toString()}`);
    }
}

// Rail 9 telemetry buckets returned alongside the Map for ops visibility.
function tallyTelemetry(totalRecords, empty, malformed, mapped) {
    const malformedPct = totalRecords > 0 ? (malformed / totalRecords) * 100 : 0;
    if (malformedPct > 0.5) {
        console.warn(`[FDA-SRS-ADAPTER] WARN malformed_inchikey rate ${malformedPct.toFixed(3)}% exceeds 0.5% threshold (count=${malformed}/${totalRecords}); upstream export quality may have regressed`);
    }
    return { total_records: totalRecords, mapped_small_molecule: mapped, expected_macromolecules: empty, malformed_trash: malformed };
}

/**
 * Download + decompress + parse the latest FDA SRS lookup artifact from R2,
 * return { map, cursor, telemetry }. Map keys are normalized InChIKey
 * (uppercase 14-10-1 canonical). Values are shared references -- callers
 * MUST NOT mutate.
 */
export async function loadLookupFromR2() {
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    // Fetch cursor JSON to discover the published data key.
    const cursorRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: CURSOR_KEY }));
    const cursorBuf = await streamToBuffer(cursorRes.Body);
    const cursor = JSON.parse(cursorBuf.toString('utf-8'));
    if (!cursor.r2_data_key) throw new Error('[FDA-SRS-ADAPTER] cursor missing r2_data_key');

    // Download compressed payload to tmp, decompress to tmp, parse.
    const tmpZst = join(tmpdir(), `fda-srs-${Date.now()}.jsonl.zst`);
    const tmpJsonl = `${tmpZst}.decoded`;
    try {
        const dataRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: cursor.r2_data_key }));
        const dataBuf = await streamToBuffer(dataRes.Body);
        writeFileSync(tmpZst, dataBuf);
        zstdDecompressFile(tmpZst, tmpJsonl);
        const jsonlText = readFileSync(tmpJsonl, 'utf-8');

        const map = new Map();
        let empty = 0, malformed = 0, mapped = 0, total = 0;
        for (const line of jsonlText.split('\n')) {
            if (!line) continue;
            total++;
            let row;
            try { row = JSON.parse(line); }
            catch { malformed++; continue; }
            const rawKey = row.inchi_key;
            if (!rawKey || (typeof rawKey === 'string' && rawKey.trim() === '')) {
                empty++; continue;
            }
            const cleanKey = normalizeInChIKey(rawKey);
            if (!cleanKey) { malformed++; continue; }
            map.set(cleanKey, { unii: row.unii, preferred_name: row.preferred_name, cas_rn: row.cas_rn });
            mapped++;
        }
        const telemetry = tallyTelemetry(total, empty, malformed, mapped);
        console.log(`[FDA-SRS-ADAPTER] Initialization metrics: total_records=${total} mapped_small_molecule=${mapped} expected_macromolecules=${empty} malformed_trash=${malformed} release=${cursor.release_date} checksum=${(cursor.parsed_header_checksum || '').slice(0, 24)}...`);
        return { map, cursor, telemetry };
    } finally {
        for (const p of [tmpZst, tmpJsonl]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
}

/**
 * O(1) lookup. Returns the SHARED REFERENCE stored in the Map (no deep
 * clone) -- Rail 10a heap-ceiling defense. Callers MUST treat the returned
 * object as read-only.
 */
export function lookupByInchiKey(inchiKey, map) {
    const cleanKey = normalizeInChIKey(inchiKey);
    if (!cleanKey) return null;
    return map.get(cleanKey) || null;
}
