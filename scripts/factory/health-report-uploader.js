/**
 * Health Report Uploader V0.5.0
 *
 * Pushes the current output/source-health.json to R2 under
 *   health-reports/<date>.json   (dated archive, append-only)
 *   health-reports/latest.json   (pointer to most recent)
 *
 * Run after `npm run health` in CI. Local copy stays at output/source-health.json
 * for the workflow log; R2 keeps the historical trail for audits and trend
 * analysis across days.
 *
 * Required environment variables:
 *   R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * If env is absent, the script exits 0 with a notice; upload is a no-op.
 */

import fs from 'fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const REPORT_PATH = process.env.HEALTH_REPORT_PATH || './output/source-health.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function envReady() {
    return REQUIRED_ENV.every(k => process.env[k]);
}

function todayUtcIso() {
    return new Date().toISOString().slice(0, 10);
}

async function main() {
    console.log('[HEALTH-UP] V0.5.0');

    if (!envReady()) {
        const missing = REQUIRED_ENV.filter(k => !process.env[k]);
        console.log(`[HEALTH-UP] R2 credentials missing (${missing.join(', ')}). Upload skipped.`);
        process.exit(0);
    }

    let reportBuf;
    try {
        reportBuf = await fs.readFile(REPORT_PATH);
    } catch (err) {
        console.error(`[HEALTH-UP] Report not found at ${REPORT_PATH}:`, err.message);
        process.exit(1);
    }

    const date = todayUtcIso();
    const archiveKey = `health-reports/${date}.json`;
    const latestKey = 'health-reports/latest.json';

    const client = new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });

    try {
        await client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: archiveKey,
            Body: reportBuf,
            ContentType: 'application/json',
        }));
        console.log(`  ${archiveKey.padEnd(40)} ${(reportBuf.length / 1024).toFixed(1).padStart(8)} KB`);

        await client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: latestKey,
            Body: reportBuf,
            ContentType: 'application/json',
        }));
        console.log(`  ${latestKey.padEnd(40)} (pointer)`);
    } catch (err) {
        console.error('[HEALTH-UP] R2 upload failed:', err.message);
        process.exit(1);
    }

    console.log(`\n[HEALTH-UP] Complete`);
    console.log(`  Archive: ${archiveKey}`);
    console.log(`  Latest:  ${latestKey}`);
}

main().catch(err => { console.error('[HEALTH-UP] Fatal:', err); process.exit(1); });
