/**
 * Snapshot Downloader V0.5.0 - pull latest daily snapshot from R2.
 *
 * Companion to snapshot-uploader.js. Reads snapshots/latest.json pointer,
 * fetches the dated manifest, then downloads every file listed in the
 * manifest to local snapshots/<date>/ so downstream scripts (health
 * monitor, audits) can run against real production data.
 *
 * Required environment variables (same as the uploader):
 *   R2_ENDPOINT          https://<accountId>.r2.cloudflarestorage.com
 *   R2_BUCKET            sciweon-prod (or your chosen bucket)
 *   R2_ACCESS_KEY_ID     Cloudflare R2 access key
 *   R2_SECRET_ACCESS_KEY Cloudflare R2 secret
 *
 * Exit codes:
 *   0   success, or no snapshot in R2 yet (graceful), or env missing
 *   1   fatal error during download
 */

import fs from 'fs/promises';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const SNAPSHOT_ROOT = './snapshots';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const LATEST_KEY = 'snapshots/latest.json';

function envReady() {
    return REQUIRED_ENV.every(k => process.env[k]);
}

function makeClient() {
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

async function getObjectBuf(client, key) {
    const res = await client.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
    }));
    return streamToBuffer(res.Body);
}

async function main() {
    console.log('[SNAPSHOT-DL] V0.5.0');

    if (!envReady()) {
        const missing = REQUIRED_ENV.filter(k => !process.env[k]);
        console.log(`[SNAPSHOT-DL] R2 credentials missing (${missing.join(', ')}). Download skipped.`);
        process.exit(0);
    }

    const client = makeClient();

    let pointer;
    try {
        const buf = await getObjectBuf(client, LATEST_KEY);
        pointer = JSON.parse(buf.toString());
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            console.log('[SNAPSHOT-DL] No snapshot in R2 yet (snapshots/latest.json missing). Workspace stays empty.');
            process.exit(0);
        }
        console.error('[SNAPSHOT-DL] Failed to read latest pointer:', err.message);
        process.exit(1);
    }

    const dateStr = pointer?.latest_snapshot_date;
    const manifestKey = pointer?.manifest_key;
    if (!dateStr || !manifestKey) {
        console.error('[SNAPSHOT-DL] Latest pointer is malformed:', pointer);
        process.exit(1);
    }
    console.log(`[SNAPSHOT-DL] Latest snapshot: ${dateStr}`);

    let manifest;
    try {
        const buf = await getObjectBuf(client, manifestKey);
        manifest = JSON.parse(buf.toString());
    } catch (err) {
        console.error(`[SNAPSHOT-DL] Failed to read manifest ${manifestKey}:`, err.message);
        process.exit(1);
    }

    const targetDir = path.join(SNAPSHOT_ROOT, dateStr);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const files = Array.isArray(manifest.files) ? manifest.files : [];
    let count = 0;
    let bytes = 0;
    for (const entry of files) {
        const fname = entry?.filename;
        if (!fname) continue;
        const key = `snapshots/${dateStr}/${fname}`;
        try {
            const buf = await getObjectBuf(client, key);
            await fs.writeFile(path.join(targetDir, fname), buf);
            bytes += buf.length;
            count++;
            console.log(`  ${key.padEnd(50)} ${(buf.length / 1024).toFixed(1).padStart(8)} KB`);
        } catch (err) {
            console.warn(`  ${key} - download failed: ${err.message}`);
        }
    }

    console.log(`\n[SNAPSHOT-DL] Complete`);
    console.log(`  Files downloaded: ${count} / ${files.length}`);
    console.log(`  Total bytes:      ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Target directory: ${targetDir}`);
}

main().catch(err => { console.error('[SNAPSHOT-DL] Fatal:', err); process.exit(1); });
