/**
 * Downloads the adapter cumulative (fan-in output at processed/aggregated/
 * in R2) to output/linked/adapter-cumulative.jsonl for use by stage-2
 * enrichers (adapter-cross-linker for WHO-ATC + DailyMed enrichment +
 * drug-labels.jsonl emission). Returns true on success, false if no
 * cumulative exists yet (first run).
 *
 * Pointer key: `fanin-latest.json` (NOT `latest.json`). PR #89 split the
 * fan-in pointer to its own key so it would not trample stage-3's
 * `latest.json`. The producer (incremental-merge-helpers.js
 * FANIN_LATEST_KEY) was updated, but this consumer was left reading the
 * old key — every cron since PR #89 silently 404'd on
 * `<stage-3 run_id>/all-records.jsonl.gz` and returned false, no-op'ing
 * adapter-cross-linker and dropping ATC/DailyMed enrichment + drug-labels
 * publication. Cycle 21 hotfix points at the correct pointer.
 */

import fs from 'fs/promises';
import path from 'path';
import { gunzipSync } from 'zlib';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const PREFIX     = 'processed/aggregated';
const FANIN_LATEST_KEY = `${PREFIX}/fanin-latest.json`;
const LINKED_DIR = './output/linked';
const OUT_FILE   = 'adapter-cumulative.jsonl';

function makeClient() {
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId:     process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

export async function downloadAdapterCumulative() {
    if (!process.env.R2_ENDPOINT) return false;
    const client = makeClient();
    const bucket = process.env.R2_BUCKET;
    try {
        const ptrRes = await client.send(new GetObjectCommand({
            Bucket: bucket, Key: FANIN_LATEST_KEY,
        }));
        const ptr = JSON.parse((await streamToBuffer(ptrRes.Body)).toString());
        const key = `${PREFIX}/${ptr.pointer}/all-records.jsonl.gz`;
        const dataRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const gz = await streamToBuffer(dataRes.Body);
        await fs.mkdir(LINKED_DIR, { recursive: true });
        await fs.writeFile(path.join(LINKED_DIR, OUT_FILE), gunzipSync(gz));
        console.log(`[BRIDGE] Adapter cumulative: ${(gz.length / 1024).toFixed(1)} KB gz → ${OUT_FILE}`);
        return true;
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return false;
        throw e;
    }
}
