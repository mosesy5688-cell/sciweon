#!/usr/bin/env node
/**
 * V0.5.8 Wave I-3 — Apply R2 lifecycle TTL to the Sciweon bucket.
 *
 * Usage:
 *   npm run r2:lifecycle:apply          — apply LIFECYCLE_RULES to R2
 *   npm run r2:lifecycle:apply -- --dry — print the JSON config, do not apply
 *
 * Requires R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 * env vars (same as factory cron). Run once after R2 bucket creation; R2
 * enforces TTL server-side — no recurring cron needed.
 *
 * Idempotent: running multiple times overwrites with the same config.
 */

import {
    S3Client,
    PutBucketLifecycleConfigurationCommand,
    GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { buildLifecycleConfig, LIFECYCLE_RULES } from './lib/r2-lifecycle-config.js';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

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

async function main() {
    const dryRun = process.argv.includes('--dry');
    const config = buildLifecycleConfig();

    console.log('[R2-LIFECYCLE] Proposed configuration:');
    console.log(JSON.stringify(config, null, 2));
    console.log(`[R2-LIFECYCLE] Rules: ${LIFECYCLE_RULES.length} (${LIFECYCLE_RULES.map(r => r.prefix + '@' + r.days + 'd').join(', ')})`);

    if (dryRun) {
        console.log('[R2-LIFECYCLE] --dry passed; not applying.');
        return;
    }

    const client = makeClient();
    await client.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: process.env.R2_BUCKET,
        LifecycleConfiguration: config,
    }));
    console.log(`[R2-LIFECYCLE] Applied to bucket ${process.env.R2_BUCKET}.`);

    const got = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: process.env.R2_BUCKET }));
    const activeCount = got.Rules?.length ?? 0;
    console.log(`[R2-LIFECYCLE] Verified ${activeCount} rules now active on bucket.`);
    if (activeCount !== LIFECYCLE_RULES.length) {
        console.warn(`[R2-LIFECYCLE] WARNING: applied ${LIFECYCLE_RULES.length} rules but read-back shows ${activeCount}. Inspect bucket manually.`);
        process.exit(1);
    }
}

main().catch(err => { console.error('[R2-LIFECYCLE] Fatal:', err.message); process.exit(1); });
