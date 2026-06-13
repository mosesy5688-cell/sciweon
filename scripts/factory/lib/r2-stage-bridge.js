/**
 * R2 Stage Bridge V0.5.x
 *
 * Helpers for the 4-stage factory chain to pass intermediate artifacts
 * through R2 instead of relying on a single GHA runner's filesystem.
 *
 * R2 layout:
 *   processed/<stage>/<run_id>/<file>     stage output bundle
 *   processed/<stage>/latest.json         pointer (next stage reads this)
 *
 * Each stage downloads the previous stage's bundle into ./output/linked/,
 * runs its scripts (in-place edits), then uploads ./output/linked/ as its
 * own bundle under its stage prefix.
 */

import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const LINKED_DIR = './output/linked';

function envReady() {
    return REQUIRED_ENV.every(k => process.env[k]);
}

// Build the R2 S3Client from env. Exported (makeR2Client) so verification
// harnesses exercise the SAME client construction the producer uses.
export function makeR2Client() {
    if (!envReady()) {
        const missing = REQUIRED_ENV.filter(k => !process.env[k]);
        throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    }
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

async function putObjectBuf(client, key, body, contentType = 'application/octet-stream') {
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
    }));
}

export async function readStagePointer(stage) {
    const client = makeR2Client();
    const key = `processed/${stage}/latest.json`;
    try {
        const buf = await getObjectBuf(client, key);
        return JSON.parse(buf.toString());
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return null;
        }
        throw err;
    }
}

export async function downloadStage(stage, files) {
    const pointer = await readStagePointer(stage);
    if (!pointer || !pointer.run_id) {
        throw new Error(`No previous run found at processed/${stage}/latest.json`);
    }
    const client = makeR2Client();
    await fs.mkdir(LINKED_DIR, { recursive: true });
    let count = 0;
    let bytes = 0;
    const missing = [];
    for (const fname of files) {
        const key = `processed/${stage}/${pointer.run_id}/${fname}`;
        try {
            const buf = await getObjectBuf(client, key);
            await fs.writeFile(path.join(LINKED_DIR, fname), buf);
            bytes += buf.length;
            count++;
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                // V0.5.x policy (2026-05-15): missing required file in a published
                // stage bundle is a hard error, not a soft skip. Producers write all
                // declared outputs unconditionally (empty array => zero-byte file).
                // A NoSuchKey here means the previous stage either crashed silently
                // or the latest.json pointer was advanced over an incomplete bundle.
                // Refuse to proceed with partial data.
                missing.push(fname);
                continue;
            }
            throw err;
        }
    }
    if (missing.length > 0) {
        throw new Error(`[BRIDGE] downloadStage(${stage}/${pointer.run_id}) aborted — ${missing.length}/${files.length} required files missing from R2: ${missing.join(', ')}. Refusing to proceed on partial input.`);
    }
    console.log(`[BRIDGE] Downloaded ${count} files (${(bytes / 1024).toFixed(1)} KB) from processed/${stage}/${pointer.run_id}/`);
    return { runId: pointer.run_id, files: count };
}

export async function uploadStage(stage, runId, files) {
    const client = makeR2Client();
    let count = 0;
    let bytes = 0;
    // V0.5.x policy (2026-05-15): every declared output must exist locally
    // before we publish the bundle. We pre-check rather than upload-then-fail
    // so that R2 never sees a half-written run prefix or a latest.json pointer
    // that references a partial bundle. Producers always write declared files
    // (empty array yields a zero-byte file); ENOENT here means a producer
    // crashed silently before the orchestrator caught it.
    const missing = [];
    for (const fname of files) {
        const local = path.join(LINKED_DIR, fname);
        try {
            await fs.stat(local);
        } catch (err) {
            if (err.code === 'ENOENT') {
                missing.push(fname);
                continue;
            }
            throw err;
        }
    }
    if (missing.length > 0) {
        throw new Error(`[BRIDGE] uploadStage(${stage}/${runId}) aborted — ${missing.length}/${files.length} required outputs missing locally: ${missing.join(', ')}. Refusing to publish partial bundle to R2.`);
    }
    for (const fname of files) {
        const local = path.join(LINKED_DIR, fname);
        const body = await fs.readFile(local);
        const key = `processed/${stage}/${runId}/${fname}`;
        await putObjectBuf(client, key, body, 'application/jsonl');
        bytes += body.length;
        count++;
    }
    const pointer = {
        stage,
        run_id: runId,
        completed_at: new Date().toISOString(),
        files: count,
    };
    await putObjectBuf(
        client,
        `processed/${stage}/latest.json`,
        Buffer.from(JSON.stringify(pointer, null, 2)),
        'application/json',
    );
    console.log(`[BRIDGE] Uploaded ${count} files (${(bytes / 1024).toFixed(1)} KB) to processed/${stage}/${runId}/`);
    return { runId, files: count, bytes };
}

export async function uploadRaw(prefix, runId, localFiles) {
    const client = makeR2Client();
    let count = 0;
    let bytes = 0;
    // V0.5.x policy (2026-05-15): every declared local file must exist.
    // Callers in stage-1-harvest already verifyNonEmpty before this point,
    // so an ENOENT here means caller / file naming drift. Refuse instead
    // of silently uploading nothing.
    const missing = [];
    for (const [localPath] of localFiles) {
        try {
            await fs.stat(localPath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                missing.push(localPath);
                continue;
            }
            throw err;
        }
    }
    if (missing.length > 0) {
        throw new Error(`[BRIDGE] uploadRaw(${prefix}/${runId}) aborted — ${missing.length}/${localFiles.length} declared files missing locally: ${missing.join(', ')}.`);
    }
    for (const [localPath, r2Name] of localFiles) {
        const body = await fs.readFile(localPath);
        const key = `raw/${prefix}/${runId}/${r2Name}`;
        await putObjectBuf(client, key, body, 'application/jsonl');
        bytes += body.length;
        count++;
    }
    console.log(`[BRIDGE] Uploaded ${count} raw files (${(bytes / 1024).toFixed(1)} KB) to raw/${prefix}/${runId}/`);
    return { runId, files: count, bytes };
}

/**
 * Download a specific run's stage bundle from R2 without touching local
 * filesystem. Returns `{ [fname]: Buffer }`. Missing files yield empty
 * buffers (different from downloadStage which throws on missing required
 * file). Use this to fetch a historical / previous bundle for in-memory
 * comparison or cumulative merge (V0.5.2.1 cumulative aggregation).
 */
export async function downloadStageByRunId(stage, runId, files) {
    const client = makeR2Client();
    const result = {};
    for (const fname of files) {
        const key = `processed/${stage}/${runId}/${fname}`;
        try {
            result[fname] = await getObjectBuf(client, key);
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                result[fname] = Buffer.alloc(0);
                continue;
            }
            throw err;
        }
    }
    return result;
}

export function deriveRunId() {
    return process.env.GITHUB_RUN_ID
        || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export async function verifyNonEmpty(filePath, minBytes = 1) {
    try {
        const stat = await fs.stat(filePath);
        if (stat.size < minBytes) {
            throw new Error(`File ${filePath} is empty (${stat.size} bytes, expected >= ${minBytes})`);
        }
        return stat.size;
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`File ${filePath} does not exist`);
        }
        throw err;
    }
}
