/**
 * Snapshot Bridge V0.7 — R2 listing helpers for Layer 4 audit + backfill.
 *
 * Cycle 22 PR-L4 addition. Centralizes R2 prefix enumeration logic shared
 * by snapshot-completeness.js + snapshot-backfill.js, mirroring the pattern of
 * r2-stage-bridge.js for stage-1..4 pipeline boundaries.
 *
 * Triple-lock anchor: this module is the scale-in-time-leg measurement
 * substrate (per [[reference_verified_facts]] triple-lock + tracker
 * Governing principle). All consumers (completeness / backfill) treat
 * its output as authoritative for "what dates exist in R2".
 */

import { S3Client, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length > 0) {
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// List all snapshot date prefixes under snapshots/.
// Returns sorted asc array of "YYYY-MM-DD" strings.
export async function listSnapshotDates(client, bucket) {
    const dates = new Set();
    let token;
    do {
        const res = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'snapshots/',
            Delimiter: '/',
            ContinuationToken: token,
        }));
        for (const cp of (res.CommonPrefixes ?? [])) {
            const m = cp.Prefix?.match(/^snapshots\/(\d{4}-\d{2}-\d{2})\/$/);
            if (m) dates.add(m[1]);
        }
        token = res.NextContinuationToken;
    } while (token);
    return [...dates].sort();
}

// HEAD snapshots/<date>/manifest.json — true if listable, false on 404.
export async function verifySnapshotPresent(client, bucket, date) {
    if (!DATE_RE.test(date)) throw new Error(`Invalid date format: ${date}`);
    try {
        await client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: `snapshots/${date}/manifest.json`,
        }));
        return true;
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
        throw err;
    }
}

// List processed/aggregated/<run_id>/ prefixes, sorted asc by run_id (which
// approximates chronological order for GHA run numbers).
export async function listAggregatedRuns(client, bucket) {
    const runs = new Set();
    let token;
    do {
        const res = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'processed/aggregated/',
            Delimiter: '/',
            ContinuationToken: token,
        }));
        for (const cp of (res.CommonPrefixes ?? [])) {
            const m = cp.Prefix?.match(/^processed\/aggregated\/(\d+)\/$/);
            if (m) runs.add(m[1]);
        }
        token = res.NextContinuationToken;
    } while (token);
    return [...runs].sort((a, b) => Number(a) - Number(b));
}

// Get HEAD metadata for an aggregated run to recover created_at.
// Returns null if probe file missing (run incomplete or not aggregated).
//
// PR-L4d fix: probe compounds-enriched.jsonl (canonical first file in
// AGGREGATED_FILES SSoT) instead of manifest.json. aggregated bundles do
// NOT contain manifest.json — that artifact is written only by stage-4
// snapshot-builder under snapshots/<date>/manifest.json. PR-L4 + L4b +
// L4c used manifest.json as probe, which 404'd on every aggregated run,
// returning empty runMetas → findNearestPriorAggregated → "No aggregated
// runs found" deadlock. Compounds-enriched.jsonl is reliably present in
// every successful aggregated upload (cycle 21 PR #112+#113 ENRICHED_FILES
// SSoT guarantees inclusion).
export async function getAggregatedRunMeta(client, bucket, runId) {
    try {
        const res = await client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: `processed/aggregated/${runId}/compounds-enriched.jsonl`,
        }));
        return {
            runId,
            lastModified: res.LastModified?.toISOString().slice(0, 10) ?? null,
        };
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

// Find the aggregated run closest to (but not later than) targetDate.
// Returns runId string or null if none found.
// "Closest prior" semantics: prefer latest run <= targetDate; if none such
// (e.g. targetDate before all runs), fall back to earliest available.
export async function findNearestPriorAggregated(client, bucket, targetDate) {
    if (!DATE_RE.test(targetDate)) throw new Error(`Invalid date format: ${targetDate}`);
    const runs = await listAggregatedRuns(client, bucket);
    if (runs.length === 0) return null;
    // Probe each run's lastModified to map run → date
    const runMetas = [];
    for (const runId of runs) {
        const meta = await getAggregatedRunMeta(client, bucket, runId);
        if (meta?.lastModified) runMetas.push(meta);
    }
    if (runMetas.length === 0) return null;
    // Prefer latest with lastModified <= targetDate
    const eligible = runMetas.filter(m => m.lastModified <= targetDate);
    if (eligible.length > 0) {
        eligible.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
        return eligible[0].runId;
    }
    // None on-or-before — fall back to earliest available
    runMetas.sort((a, b) => a.lastModified.localeCompare(b.lastModified));
    return runMetas[0].runId;
}

// Compute expected calendar dates from (today - windowDays) to today inclusive.
// Returns sorted asc array of "YYYY-MM-DD".
//
// PR-L4e extension: optional infraStart cutoff trims the lower bound.
// Dates before infraStart are filtered out (snapshot infrastructure
// didn't exist yet — counting them as "missing" creates false positives).
// Pass null/undefined to disable the cutoff (original behavior).
export function expectedDateRange(windowDays, todayIso, infraStart) {
    const today = todayIso ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(today)) throw new Error(`Invalid today: ${today}`);
    if (infraStart != null && !DATE_RE.test(infraStart)) {
        throw new Error(`Invalid infraStart: ${infraStart}`);
    }
    const dates = [];
    const t = new Date(today + 'T00:00:00Z');
    for (let i = windowDays; i >= 0; i--) {
        const d = new Date(t);
        d.setUTCDate(d.getUTCDate() - i);
        const iso = d.toISOString().slice(0, 10);
        if (infraStart != null && iso < infraStart) continue;
        dates.push(iso);
    }
    return dates;
}

// Auto-detect infrastructure start date = earliest present snapshot in R2.
// Returns YYYY-MM-DD or null if no snapshots exist yet (pre-infrastructure
// entirely).  Dates before this are not actionable as "missing" because
// snapshot-builder workflow did not exist back then.
export function detectInfraStart(presentDates) {
    if (!Array.isArray(presentDates) || presentDates.length === 0) return null;
    // Already sorted asc by listSnapshotDates; defensive resort for callers
    // passing arbitrary arrays.
    const sorted = [...presentDates].sort();
    return sorted[0];
}

// Diff expected vs present, returning {present, missing, present_pct} stats.
export function computeCompleteness(expected, present) {
    const presentSet = new Set(present);
    const present_in_window = expected.filter(d => presentSet.has(d));
    const missing = expected.filter(d => !presentSet.has(d));
    const present_pct = expected.length === 0 ? 100 : +(100 * present_in_window.length / expected.length).toFixed(2);
    return { present: present_in_window, missing, present_pct };
}
