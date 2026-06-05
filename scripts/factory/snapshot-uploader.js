/**
 * Snapshot Uploader V0.4.3 — push daily snapshot to Cloudflare R2.
 *
 * Daily time-series snapshot requires durable off-machine storage. R2 is
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
    // Date precedence: --date CLI arg > TARGET_DATE env (cycle 22 PR-L4
    // backfill) > today.
    const dateStr = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
        || process.env.TARGET_DATE
        || todayUtcIso();
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

    // PR-T1.1-LEVER: the uploader NO LONGER writes snapshots/latest.json.
    // The pointer is now owned by the ONE terminal swapLatestPointer in
    // stage-4-upload.js (publish-shards-and-swap.js), which merges ALL keys
    // (latest_snapshot_date, manifest_key, compounds_manifest_key,
    // neg_evidence_manifest_key) in a single CAS write AFTER both the compound
    // and neg shards are published + integrity-verified. Two separate writers
    // (uploader + compound block) used to race last-writer-wins and could drop
    // a sibling manifest key. Backfill (snapshot-backfill.js) always wanted
    // SKIP_LATEST_SWAP anyway, so the old-date snapshot is published without
    // touching the live pointer exactly as before.
    console.log(`\n[SNAPSHOT-UPLOADER] Complete`);
    console.log(`  Files uploaded:  ${uploaded}`);
    console.log(`  Total bytes:     ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Latest pointer:  not touched (owned by stage-4 terminal swap)`);
}

main().catch(err => { console.error('[SNAPSHOT-UPLOADER] Fatal:', err); process.exit(1); });
