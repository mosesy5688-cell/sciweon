/**
 * Snapshot Uploader V0.4.3 — push daily snapshot to Cloudflare R2.
 *
 * Layer 4 time-series clock requires durable off-machine storage. R2 is
 * Sciweon's primary persistence (zero egress fees, CC0-friendly).
 *
 * Required environment variables (set as GHA repo secrets):
 *   R2_ENDPOINT          https://<accountId>.r2.cloudflarestorage.com
 *   R2_BUCKET            sciweon-snapshots (or your chosen bucket)
 *   R2_ACCESS_KEY_ID     Cloudflare R2 access key
 *   R2_SECRET_ACCESS_KEY Cloudflare R2 secret
 *
 * If env vars are absent, this step exits 0 with a notice — the snapshot
 * is still built locally + git-trackable manifest stays current. Upload
 * activates as soon as credentials are configured (no code change needed).
 */

import fs from 'fs/promises';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const SNAPSHOT_ROOT = './snapshots';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function todayUtcIso() {
    return new Date().toISOString().slice(0, 10);
}

function envReady() {
    return REQUIRED_ENV.every(k => process.env[k]);
}

async function main() {
    const dateStr = process.argv.find(a => a.startsWith('--date='))?.split('=')[1] || todayUtcIso();
    console.log(`[SNAPSHOT-UPLOADER] V0.4.3 — push snapshot ${dateStr} to R2`);

    if (!envReady()) {
        const missing = REQUIRED_ENV.filter(k => !process.env[k]);
        console.log(`[SNAPSHOT-UPLOADER] R2 credentials not configured (missing: ${missing.join(', ')})`);
        console.log(`[SNAPSHOT-UPLOADER] Snapshot built locally; upload skipped. See docs/SNAPSHOT_SETUP.md.`);
        return;
    }

    const snapshotDir = path.join(SNAPSHOT_ROOT, dateStr);
    let files;
    try { files = await fs.readdir(snapshotDir); }
    catch {
        console.error(`[SNAPSHOT-UPLOADER] Snapshot dir not found: ${snapshotDir}`);
        process.exit(1);
    }

    const client = new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });

    let uploaded = 0;
    let totalBytes = 0;
    for (const fname of files) {
        const localPath = path.join(snapshotDir, fname);
        const body = await fs.readFile(localPath);
        const key = `snapshots/${dateStr}/${fname}`;
        await client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
            Body: body,
            ContentType: fname.endsWith('.gz') ? 'application/gzip' : 'application/json',
        }));
        uploaded++;
        totalBytes += body.length;
        console.log(`  ${key.padEnd(50)} ${(body.length / 1024).toFixed(1).padStart(8)} KB`);
    }

    // Update "latest" pointer
    const manifestKey = `snapshots/${dateStr}/manifest.json`;
    const latestPointer = JSON.stringify({ latest_snapshot_date: dateStr, manifest_key: manifestKey });
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: 'snapshots/latest.json',
        Body: latestPointer,
        ContentType: 'application/json',
    }));

    console.log(`\n[SNAPSHOT-UPLOADER] Complete`);
    console.log(`  Files uploaded:  ${uploaded}`);
    console.log(`  Total bytes:     ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Latest pointer:  snapshots/latest.json -> ${dateStr}`);
}

main().catch(err => { console.error('[SNAPSHOT-UPLOADER] Fatal:', err); process.exit(1); });
