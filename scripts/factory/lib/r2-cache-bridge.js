/**
 * V0.5.7 — R2 cache bridge.
 *
 * Cross-cycle persistence for stage-2 caches (e.g. chembl negative
 * InChIKey cache, Wave H2b-4). Lives at r2://processed/cache/<fname>;
 * download-or-bootstrap on stage-2 start, upload after enrichers finish.
 *
 * Intentionally separate from lib/r2-stage-bridge.js (246 lines, at the
 * 250-line CES cap). Stage I/O semantics differ too: caches have no
 * run_id (monotonically growing single object), so a separate helper
 * keeps responsibilities clean.
 *
 * Soft-miss policy: 404 on download = "no prior cache yet, start fresh"
 * (returns silently). All other errors throw. Upload likewise tolerates
 * ENOENT (enricher may not have produced a cache file this run) but
 * fails on any other error.
 */

import fs from 'fs/promises';
import path from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const LINKED_DIR = './output/linked';
const CACHE_PREFIX = 'processed/cache';

function makeClient() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

export async function downloadCache(fname) {
    const client = makeClient();
    await fs.mkdir(LINKED_DIR, { recursive: true });
    try {
        const res = await client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET, Key: `${CACHE_PREFIX}/${fname}`,
        }));
        const buf = await streamToBuffer(res.Body);
        await fs.writeFile(path.join(LINKED_DIR, fname), buf);
        console.log(`[CACHE-BRIDGE] Downloaded ${fname} (${buf.length} bytes)`);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            console.log(`[CACHE-BRIDGE] No prior ${fname} in R2 — starting fresh`);
            return;
        }
        throw err;
    }
}

export async function uploadCache(fname) {
    const client = makeClient();
    const local = path.join(LINKED_DIR, fname);
    let body;
    try { body = await fs.readFile(local); }
    catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`[CACHE-BRIDGE] Local ${fname} missing — skip upload`);
            return;
        }
        throw err;
    }
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET, Key: `${CACHE_PREFIX}/${fname}`,
        Body: body, ContentType: 'application/json',
    }));
    console.log(`[CACHE-BRIDGE] Uploaded ${fname} (${body.length} bytes)`);
}
