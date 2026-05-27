/**
 * RxNorm bulk adapter (PR-RXN-1).
 *
 * BULK FILE adapter (not per-record API). Downloads the latest published
 * rxcui-index.jsonl.zst from R2, decompresses streaming, builds two
 * in-memory Maps for O(1) lookup at enrichment time:
 *   uniiToRxcui:  Map<unii, { rxcui, preferred_str, tty, sab }>   -- 1:1
 *   ndcToRxcuis:  Map<ndc,  Set<{ rxcui, preferred_str, tty, sab }>> -- 1:N
 *
 * 1:N for NDC preserves combination-product semantics: one NDC routinely
 * maps to multiple ingredient RxCUIs (e.g., Combivent ipratropium + albuterol).
 * Callers iterate the Set to backlink the label to every active ingredient
 * compound.
 *
 * Adapter consumers (post PR-RXN-1):
 *   PR-RXN-1b compound enricher uses lookupByUnii(maps, unii)
 *   PR-RXN-1b DailyMed cross-linker uses lookupByNdc(maps, ndc)
 */

import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const CURSOR_KEY = 'state/rxnorm-bulk-cursor.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[RXNORM-BULK-ADAPTER] missing env: ${missing.join(', ')}`);
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
    if (result.error) throw new Error(`[RXNORM-BULK-ADAPTER] zstd spawn: ${result.error.message}`);
    if (result.status !== 0) {
        throw new Error(`[RXNORM-BULK-ADAPTER] zstd exit ${result.status}: ${result.stderr?.toString()}`);
    }
}

/**
 * Parse JSONL text into the two-Map structure. First line of the JSONL is
 * an optional license_metadata header (prefix '#'); subsequent lines are
 * records. Pure function -- testable without R2.
 */
export function parseRxcuiIndexJsonl(jsonlText) {
    const uniiToRxcui = new Map();
    const ndcToRxcuis = new Map();
    let licenseMetadata = null;
    let totalRecords = 0;

    for (const rawLine of jsonlText.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#')) {
            try {
                const headerObj = JSON.parse(line.slice(1));
                licenseMetadata = headerObj.license_metadata ?? null;
            } catch { /* malformed header; ignore */ }
            continue;
        }

        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || !rec.rxcui) continue;
        totalRecords++;

        const meta = { rxcui: rec.rxcui, preferred_str: rec.preferred_str, tty: rec.tty, sab: rec.sab };

        if (typeof rec.unii === 'string' && rec.unii.length > 0) {
            uniiToRxcui.set(rec.unii, meta);
        }
        if (Array.isArray(rec.ndcs)) {
            for (const ndc of rec.ndcs) {
                if (typeof ndc !== 'string' || ndc.length === 0) continue;
                if (!ndcToRxcuis.has(ndc)) ndcToRxcuis.set(ndc, new Set());
                ndcToRxcuis.get(ndc).add(meta);
            }
        }
    }
    return { uniiToRxcui, ndcToRxcuis, licenseMetadata, totalRecords };
}

/**
 * Download + decompress + parse latest RxNorm bulk artifact from R2.
 * Returns { uniiToRxcui, ndcToRxcuis, cursor, licenseMetadata, totalRecords }.
 */
export async function loadRxnormBulkMaps() {
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;
    const cursorRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: CURSOR_KEY }));
    const cursorBuf = await streamToBuffer(cursorRes.Body);
    const cursor = JSON.parse(cursorBuf.toString('utf-8'));
    if (!cursor.r2_data_key) throw new Error('[RXNORM-BULK-ADAPTER] cursor missing r2_data_key');

    const tmpZst = join(tmpdir(), `rxnorm-bulk-${Date.now()}.jsonl.zst`);
    const tmpJsonl = `${tmpZst}.decoded`;
    try {
        const dataRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: cursor.r2_data_key }));
        writeFileSync(tmpZst, await streamToBuffer(dataRes.Body));
        zstdDecompressFile(tmpZst, tmpJsonl);
        const jsonlText = readFileSync(tmpJsonl, 'utf-8');
        const parsed = parseRxcuiIndexJsonl(jsonlText);
        console.log(`[RXNORM-BULK-ADAPTER] loaded release=${cursor.release_date} records=${parsed.totalRecords} unii_keys=${parsed.uniiToRxcui.size} ndc_keys=${parsed.ndcToRxcuis.size}`);
        return { ...parsed, cursor };
    } finally {
        for (const p of [tmpZst, tmpJsonl]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
}

/** O(1) UNII -> ingredient RxCUI meta lookup. Returns null on miss. */
export function lookupByUnii(maps, unii) {
    if (typeof unii !== 'string' || unii.length === 0) return null;
    return maps?.uniiToRxcui?.get(unii) ?? null;
}

/** O(1) NDC -> Set of ingredient RxCUI metas lookup. Returns empty Set on miss. */
export function lookupByNdc(maps, ndc) {
    if (typeof ndc !== 'string' || ndc.length === 0) return new Set();
    return maps?.ndcToRxcuis?.get(ndc) ?? new Set();
}
