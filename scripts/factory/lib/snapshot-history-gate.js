/**
 * V0.5.5 — Stage-4 historical-comparison gate.
 *
 * Defense-in-depth for [[feedback_cross_cycle_silent_data_loss]] —
 * even if stage-3 silent-skip slips through (H1-2 sentinel), stage-4
 * must independently refuse to publish a snapshot that regresses the
 * record count by more than `dropThresholdPct` vs the previous snapshot.
 *
 * 2026-05-18 production regression escaped both V0.5.2.1 merge fix and
 * `verifyNonEmpty` (which only requires >100 bytes — 5000 records × 1.9KB
 * each = ~9MB, sailed through). This gate enforces a *historical* check
 * (previous snapshot manifest) rather than a content-presence check.
 *
 * Default threshold: 30% drop = reject. Tunable via env
 * `SCIWEON_RECORD_DROP_THRESHOLD_PCT` (integer 1-99).
 *
 * Behavior:
 *   - No previous snapshot: skip gate (first-ever publish allowed)
 *   - Previous manifest unreadable: hard abort (operator must investigate)
 *   - Drop > threshold: hard abort (exit 5, "regression suspected")
 *   - Drop <= threshold: pass, publish proceeds
 */

import fs from 'fs/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const DEFAULT_DROP_THRESHOLD_PCT = 30;

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

async function getJsonObject(client, key) {
    const res = await client.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
    }));
    const buf = await streamToBuffer(res.Body);
    return JSON.parse(buf.toString('utf-8'));
}

export async function loadPreviousSnapshotManifest() {
    const client = makeClient();
    let pointer;
    try {
        pointer = await getJsonObject(client, 'snapshots/latest.json');
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
    if (!pointer?.manifest_key) return null;
    return await getJsonObject(client, pointer.manifest_key);
}

export async function countJsonlRecords(filePath) {
    const raw = await fs.readFile(filePath, 'utf-8');
    let count = 0;
    for (const line of raw.split('\n')) if (line.trim()) count++;
    return count;
}

/**
 * Pure function: decide gate action.
 *
 * Inputs:
 *   - currentRecords: integer (line count of current compounds-enriched.jsonl)
 *   - previousRecords: integer | null (record count from previous manifest)
 *   - thresholdPct: integer 1-99 (drop % that triggers abort)
 *
 * Returns:
 *   - { kind: 'skip_no_previous', reason }    → first-ever publish, pass
 *   - { kind: 'pass', dropPct, ... }          → drop within threshold
 *   - { kind: 'abort_regression', dropPct, ...} → exceeds threshold, exit 5
 */
export function decideGateAction({ currentRecords, previousRecords, thresholdPct }) {
    if (previousRecords === null || previousRecords === undefined) {
        return { kind: 'skip_no_previous', reason: 'no previous snapshot' };
    }
    if (previousRecords === 0) {
        return { kind: 'skip_no_previous', reason: 'previous snapshot had 0 records' };
    }
    const dropPct = ((previousRecords - currentRecords) / previousRecords) * 100;
    const meta = { currentRecords, previousRecords, dropPct: +dropPct.toFixed(2), thresholdPct };
    if (dropPct > thresholdPct) {
        return { kind: 'abort_regression', ...meta };
    }
    return { kind: 'pass', ...meta };
}

export function getConfiguredThreshold() {
    const raw = process.env.SCIWEON_RECORD_DROP_THRESHOLD_PCT;
    if (!raw) return DEFAULT_DROP_THRESHOLD_PCT;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 1 || n > 99) return DEFAULT_DROP_THRESHOLD_PCT;
    return n;
}
