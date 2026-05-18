/**
 * Downloads the adapter cumulative (processed/aggregated/ in R2) to
 * output/linked/adapter-cumulative.jsonl for use by stage-2 enrichers.
 * Returns true on success, false if no cumulative exists yet (first run).
 */

import fs from 'fs/promises';
import path from 'path';
import { gunzipSync } from 'zlib';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const PREFIX     = 'processed/aggregated';
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
            Bucket: bucket, Key: `${PREFIX}/latest.json`,
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
