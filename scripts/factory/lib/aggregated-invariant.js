/**
 * Pre-upload invariant guard for stage-3-aggregate.js (PR-CORE-MERGE-LEAK,
 * PR-INV-ISOLATE 2026-05-28).
 *
 * Runs AFTER all F3 stages complete (cumulative-merge, aggregated-backfill,
 * OT merge, SID stampers, indices) and BEFORE uploadStage('aggregated',...).
 *
 * Phase Isolation Blueprint (PR-INV-ISOLATE 2026-05-28, architect lock):
 * Stage 3 owns its own state lifecycle. Reads + writes a dedicated stats
 * file `state/f3-aggregated-stats.json` that is independent of SC
 * (Stage 4) outputs. This severs cross-stage temporal boundary
 * contamination: prior cycle's INVARIANT-derived UNII count is the SOLE
 * comparison source, never SC's unichem.fully_enriched (which decoupled
 * from raw UNII count post PR-FDA-SRS-3c Option E because compound-id-resolver
 * can set unichem_matched=true on records with unii=null when UniChem
 * returns xrefs lacking UNII).
 *
 * Auto-bootstrap (zero-config first deploy): missing stats file -> log
 * bootstrap notice + write current count as new baseline + return clean
 * (NO throw, NO halt). First post-deploy cycle is structurally a no-op
 * on the regression check; cycle 2+ has a valid baseline.
 *
 * Per [[cross_cycle_silent_data_loss]] zero-tolerance: real regressions
 * (currentCount < prevCount when prevCount exists) HARD-FAIL the cycle;
 * R2 publish is halted; next-cycle retry has a race-free comparison origin.
 */

import fs from 'fs/promises';
import path from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const STATS_KEY = 'state/f3-aggregated-stats.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length > 0) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
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

// PR-FDA-SRS-3 universal UNII guard (architect V6 spec 2026-05-27):
// source-agnostic counter -- counts ANY record with canonical UNII,
// regardless of which source (UniChem OR FDA SRS OR future RxNorm bulk).
// Aligns invariant with [[researcher_needs_anchor]]: researcher cares
// about "compound has canonical UNII" not "UNII came from specific source".
// Replaces single-source countFullyEnrichedUnichem which would inflate
// after FDA SRS shipped (false-credit for FDA-filled UNII).
export function countFullyEnrichedUnii(records) {
    let count = 0;
    for (const r of records) {
        const ext = r?.external_ids;
        if (!ext) continue;
        if (ext.unii == null || ext.unii === '') continue;
        count++;
    }
    return count;
}

// Backward-compat alias for any external caller; new code uses
// countFullyEnrichedUnii directly.
export const countFullyEnrichedUnichem = countFullyEnrichedUnii;

async function loadLocalCompounds(localPath) {
    const content = await fs.readFile(localPath, 'utf-8');
    const out = [];
    for (const line of content.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed; not invariant's concern */ }
    }
    return out;
}

/**
 * Fetch the prior cycle's F3-managed stats blob. Returns null on absence
 * (true first-deploy / state wipe) which triggers the auto-bootstrap path.
 * Throws on any other R2 error so the cycle does not silently lose its
 * regression check.
 */
async function fetchPrevF3Stats(client, bucket) {
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: STATS_KEY }));
        const buf = await streamToBuffer(res.Body);
        return JSON.parse(buf.toString());
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

async function writeF3Stats(client, bucket, payload) {
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: STATS_KEY,
        Body: JSON.stringify(payload, null, 2),
        ContentType: 'application/json',
    }));
}

/**
 * Run the invariant guard. Returns {checked, prev, current, delta} on
 * success; THROWS on regression detection (caller MUST NOT swallow the
 * throw -- R2 publish must not proceed if invariant fails).
 *
 * Stage 3 owns its own state lifecycle per Phase Isolation Blueprint.
 * Each call either (a) auto-bootstraps a baseline on first run, or (b)
 * compares against the cycle's own prior baseline + advances the baseline
 * on green.
 *
 * @param {object} opts
 * @param {string} opts.localCompoundsPath Path to final post-F3 compounds-enriched.jsonl
 * @param {string} [opts.runId] Current run_id; recorded in stats for traceability
 * @param {string} [opts.label] Log prefix (default '[INVARIANT-GATE]')
 */
export async function enforceCompletenessInvariant({ localCompoundsPath, runId = null, label = '[INVARIANT-GATE]' }) {
    let client, bucket;
    try {
        client = makeR2Client();
        bucket = process.env.R2_BUCKET;
    } catch (err) {
        console.warn(`${label} R2 client init failed (${err.message}) -- skipping invariant check (bootstrap-safe)`);
        return { checked: false, reason: 'r2_client_init_failed' };
    }

    const finalCompounds = await loadLocalCompounds(localCompoundsPath);
    const currentCount = countFullyEnrichedUnii(finalCompounds);
    const totalCompounds = finalCompounds.length;
    const audit_date = new Date().toISOString().slice(0, 10);

    const prevStats = await fetchPrevF3Stats(client, bucket);

    // Auto-bootstrap path: first deploy / state wipe / pre-isolation-cutover
    // transition cycle. Write the current count as the new baseline AND
    // exempt this cycle from regression check.
    if (!prevStats || typeof prevStats.universal_unii_count !== 'number') {
        console.warn(`${label} [BOOTSTRAP] No prior F3 stats found at ${STATS_KEY} -- initializing baseline from current count (universal_unii_count=${currentCount}, total_compounds=${totalCompounds}). Cycle exempted from regression check.`);
        await writeF3Stats(client, bucket, {
            audit_date,
            last_processed_run_id: runId,
            universal_unii_count: currentCount,
            total_compounds: totalCompounds,
            bootstrap: true,
        });
        return { checked: false, reason: 'bootstrap_initialized', current: currentCount, totalCompounds };
    }

    const prevCount = prevStats.universal_unii_count;
    const delta = currentCount - prevCount;
    if (currentCount < prevCount) {
        // Hard-fail before any state mutation -- the R2 stats file STAYS at
        // prior green baseline so next-cycle retry has a race-free origin.
        throw new Error(
            `${label} CRITICAL REGRESSION DETECTED: universal UNII count dropped ${prevCount} -> ${currentCount} (delta=${delta}). ` +
            `Cumulative-merge data leak suspected (PR-CORE-MERGE-LEAK class) OR multi-source UNII pipeline broke. Halting R2 publish per [[cross_cycle_silent_data_loss]] zero-tolerance.`
        );
    }

    // Green path: advance the baseline.
    await writeF3Stats(client, bucket, {
        audit_date,
        last_processed_run_id: runId,
        universal_unii_count: currentCount,
        total_compounds: totalCompounds,
        prior_run_id: prevStats.last_processed_run_id ?? null,
        prior_universal_unii_count: prevCount,
        prior_delta: delta,
    });

    console.log(`${label} Invariant verified green | universal UNII count: ${prevCount} -> ${currentCount} (delta=${delta > 0 ? '+' : ''}${delta}) | total_compounds=${totalCompounds}`);
    return { checked: true, prev: prevCount, current: currentCount, delta, totalCompounds };
}
