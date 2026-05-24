/**
 * SID Stage-3 Shared — Phase 1.3 extraction of helpers used identically
 * across Phase 1.1c (compound), Phase 1.2 (trial), and Phase 1.3+ (paper /
 * target / bioactivity / SAL) stage-3 orchestrators.
 *
 * Defect-6 architecture: the only crosswalk update API is
 * `casExecuteCrosswalkUpdate({prepareAdditionsFn})` which encapsulates
 * Load -> callback -> Merge -> Put as one atomic unit INSIDE the retry
 * loop. Callers cannot accidentally implement the broken "load once
 * outside retry" pattern that would risk silent lost-write hazards under
 * concurrent or retry-overlap conditions.
 *
 * Phase 1.1c + 1.2 orchestrators currently use the inline casPutCrosswalk
 * pattern; cleanup PR will migrate them to call casExecuteCrosswalkUpdate.
 * Phase 1.3 paper orchestrator uses this API natively from day-one.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { S3Client } from '@aws-sdk/client-s3';
import {
    loadCrosswalkRaw, putCrosswalkRaw, parseCrosswalkJsonl,
    mergeEntries, serializeEntries, isPreconditionFailed, MAX_CROSSWALK_CAS_RETRIES,
} from './sid-crosswalk.js';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export function makeR2Client(label = 'SID-STAGE3') {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[${label}] missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

export function zstdRun(args, input, label = 'SID-STAGE3') {
    const tmpIn = path.join(os.tmpdir(), `${label.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tmpOut = `${tmpIn}.out`;
    writeFileSync(tmpIn, input);
    try {
        const res = spawnSync('zstd', [...args, '-o', tmpOut, tmpIn]);
        if (res.error) throw new Error(`[${label}] zstd spawn: ${res.error.message}`);
        if (res.status !== 0) throw new Error(`[${label}] zstd exit ${res.status}: ${res.stderr?.toString()}`);
        return readFileSync(tmpOut);
    } finally {
        try { unlinkSync(tmpIn); } catch { /* ignore */ }
        try { unlinkSync(tmpOut); } catch { /* ignore */ }
    }
}

export function zstdCompress(buf, label) { return zstdRun(['-f'], buf, label); }
export function zstdDecompress(buf, label) { return zstdRun(['-d', '-f'], buf, label); }

export async function readJsonlFile(filePath) {
    const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
    const records = [];
    let parseErrors = 0;
    for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { parseErrors++; }
    }
    return { records, parseErrors };
}

export async function backoff(attempt, capMs = 1000) {
    const ms = Math.min(50 * Math.pow(2, attempt), capMs);
    await new Promise(r => setTimeout(r, ms));
}

export async function loadCrosswalkState({ entityClass, client, bucket, label = 'SID-STAGE3' }) {
    const { compressedBuffer, etag } = await loadCrosswalkRaw({ entityClass, client, bucket });
    if (!compressedBuffer) return { entries: [], etag: null };
    const decompressed = zstdDecompress(compressedBuffer, label);
    const entries = parseCrosswalkJsonl(decompressed.toString('utf-8'));
    return { entries, etag };
}

/**
 * Callback-based atomic Read-Modify-Write for crosswalk updates.
 * Defect-6 fix: the load+callback+merge+put cycle runs entirely INSIDE
 * the retry loop. Each attempt freshly loads remote crosswalk state,
 * invokes prepareAdditionsFn(currentEntries), merges, and conditional-
 * PUTs with the just-captured ETag. Callers cannot side-step the retry
 * loop because the callback only fires inside it.
 *
 * @param prepareAdditionsFn  async (currentEntries) => additionsArray
 *   Called once per attempt with the freshly-loaded crosswalk entries.
 *   Return the array of entries to merge. May inspect currentEntries
 *   to make remote-state-aware additions (e.g., dedupe). For simple
 *   pre-computed additions, return the precomputed array regardless.
 */
export async function casExecuteCrosswalkUpdate({
    entityClass, label = 'SID-STAGE3', client, bucket, prepareAdditionsFn,
}) {
    if (typeof prepareAdditionsFn !== 'function') {
        throw new Error(`[${label}] casExecuteCrosswalkUpdate requires prepareAdditionsFn callback`);
    }
    for (let attempt = 0; attempt < MAX_CROSSWALK_CAS_RETRIES; attempt++) {
        const { entries: currentEntries, etag } = await loadCrosswalkState({ entityClass, client, bucket, label });
        const additions = await prepareAdditionsFn(currentEntries);
        if (!Array.isArray(additions)) {
            throw new Error(`[${label}] prepareAdditionsFn must return array`);
        }
        const merged = mergeEntries(currentEntries, additions);
        const compressed = zstdCompress(Buffer.from(serializeEntries(merged), 'utf-8'), label);
        const opts = etag ? { ifMatch: etag } : { ifNoneMatch: '*' };
        try {
            const result = await putCrosswalkRaw({
                entityClass, compressedBuffer: compressed, ...opts, client, bucket,
            });
            return { ...result, totalEntries: merged.length, additionsCount: additions.length, attemptsUsed: attempt + 1 };
        } catch (err) {
            if (!isPreconditionFailed(err)) throw err;
            console.warn(`[${label}] crosswalk CAS 412 attempt=${attempt + 1} — reload + retry`);
            await backoff(attempt);
        }
    }
    throw new Error(`[${label}] crosswalk CAS exhausted after ${MAX_CROSSWALK_CAS_RETRIES} attempts — concurrent writer detected; re-dispatch idempotently`);
}
