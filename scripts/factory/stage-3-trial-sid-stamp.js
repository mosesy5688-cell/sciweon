/**
 * Stage-3 trial SID stamping orchestrator — Phase 1.2 (cycle 23).
 *
 * Reads output/linked/trials.jsonl (post trial-linker + ctis-trial-linker
 * + trial-results-enricher), stamps each trial with sid_s + sid_c per V1.0
 * §35 Dual-SID + §26 trial canonical anchor (registry+trial_id field-shape
 * detection per defect-3 fix). Persists ledger + crosswalk to R2, rewrites
 * trials.jsonl in place.
 *
 * Mirrors Phase 1.1c stage-3-sid-stamp.js 11-step orchestration shape per
 * SCIWEON_SID_AWARE_INGEST_PATTERN.md. Pattern adoption proof point —
 * second entity class on the locked template.
 *
 * Failure mode: HARD FAIL (non-zero exit). Identity infrastructure cannot
 * have coverage gaps in published snapshots.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { S3Client } from '@aws-sdk/client-s3';
import {
    reserveCounterBatch, appendBatchLedger, DEFAULT_BATCH_SIZE,
} from './lib/sid-counter-ledger.js';
import {
    loadCrosswalkRaw, putCrosswalkRaw, buildCrosswalkIndex,
    parseCrosswalkJsonl, mergeEntries, serializeEntries,
    isPreconditionFailed, MAX_CROSSWALK_CAS_RETRIES,
} from './lib/sid-crosswalk.js';
import { planReservations } from './lib/sid-stamping.js';
import {
    TRIAL_ENTITY_CLASS, TRIAL_CANON_VERSION,
    classifyTrials, buildTrialStampingEntries,
    applyStampsToTrials, buildTrialStampingSummary,
} from './lib/sid-trial-stamping.js';

const TRIALS_PATH = 'output/linked/trials.jsonl';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[TRIAL-STAMP] missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

function zstdRun(args, input) {
    const tmpIn = path.join(os.tmpdir(), `trial-stamp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tmpOut = `${tmpIn}.out`;
    writeFileSync(tmpIn, input);
    try {
        const res = spawnSync('zstd', [...args, '-o', tmpOut, tmpIn]);
        if (res.error) throw new Error(`zstd spawn: ${res.error.message}`);
        if (res.status !== 0) throw new Error(`zstd exit ${res.status}: ${res.stderr?.toString()}`);
        return readFileSync(tmpOut);
    } finally {
        try { unlinkSync(tmpIn); } catch { /* ignore */ }
        try { unlinkSync(tmpOut); } catch { /* ignore */ }
    }
}
const zstdCompress = (buf) => zstdRun(['-f'], buf);
const zstdDecompress = (buf) => zstdRun(['-d', '-f'], buf);

async function readJsonlFile(filePath) {
    const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
    const records = [];
    let parseErrors = 0;
    for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { parseErrors++; }
    }
    return { records, parseErrors };
}

async function backoff(attempt) {
    const ms = Math.min(50 * Math.pow(2, attempt), 1000);
    await new Promise(r => setTimeout(r, ms));
}

async function loadCrosswalkState(client, bucket) {
    const { compressedBuffer, etag } = await loadCrosswalkRaw({ entityClass: TRIAL_ENTITY_CLASS, client, bucket });
    if (!compressedBuffer) return { entries: [], etag: null };
    const decompressed = zstdDecompress(compressedBuffer);
    const entries = parseCrosswalkJsonl(decompressed.toString('utf-8'));
    return { entries, etag };
}

async function casPutCrosswalk(client, bucket, newEntries) {
    for (let attempt = 0; attempt < MAX_CROSSWALK_CAS_RETRIES; attempt++) {
        const { entries: existing, etag } = await loadCrosswalkState(client, bucket);
        const merged = mergeEntries(existing, newEntries);
        const compressed = zstdCompress(Buffer.from(serializeEntries(merged), 'utf-8'));
        const opts = etag ? { ifMatch: etag } : { ifNoneMatch: '*' };
        try {
            const result = await putCrosswalkRaw({
                entityClass: TRIAL_ENTITY_CLASS, compressedBuffer: compressed,
                ...opts, client, bucket,
            });
            return { ...result, totalEntries: merged.length, attemptsUsed: attempt + 1 };
        } catch (err) {
            if (!isPreconditionFailed(err)) throw err;
            console.warn(`[TRIAL-STAMP] crosswalk CAS 412 attempt=${attempt + 1} — reload + retry`);
            await backoff(attempt);
        }
    }
    throw new Error(`[TRIAL-STAMP] crosswalk CAS exhausted after ${MAX_CROSSWALK_CAS_RETRIES} attempts — concurrent writer detected; re-dispatch idempotently`);
}

async function main() {
    const startMs = Date.now();
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;
    console.log(`[TRIAL-STAMP] Phase 1.2 stamping | entity_class=${TRIAL_ENTITY_CLASS}`);

    const { records: trials, parseErrors } = await readJsonlFile(TRIALS_PATH);
    if (parseErrors > 0) throw new Error(`[TRIAL-STAMP] trial parse errors: ${parseErrors} - aborting`);
    console.log(`[TRIAL-STAMP] Loaded ${trials.length} trials from ${TRIALS_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState(client, bucket);
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[TRIAL-STAMP] Crosswalk loaded: ${crosswalkEntries.length} existing entries`);

    const { alreadyStamped, unstamped, unstampable } = classifyTrials(trials, crosswalkIndex);
    console.log(`[TRIAL-STAMP] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - id=${u.trial?.id} reason=${u.reason}`).join('\n');
        throw new Error(`[TRIAL-STAMP] HALT: ${unstampable.length}/${trials.length} trials unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance — upstream trial-linker schema gate may have regressed).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
    }

    const ledgerKeys = [];
    const newCrosswalkEntries = [];
    const newlyStampedMap = new Map();
    const plan = planReservations(unstamped.length, DEFAULT_BATCH_SIZE);
    console.log(`[TRIAL-STAMP] Reservation plan: ${plan.length} batches (${plan.map(p => p.counterCount).join('+') || '0'})`);

    let cursor = 0;
    for (let i = 0; i < plan.length; i++) {
        const { counterCount } = plan[i];
        const issuedAt = new Date().toISOString();
        const reservation = await reserveCounterBatch(
            { entityClass: TRIAL_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-trial-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[TRIAL-STAMP] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildTrialStampingEntries({
            unstamped: slice, counterStart: reservation.counterStart,
            reservationId: reservation.reservationId, issuanceAt: issuedAt,
            canonicalizationVersion: TRIAL_CANON_VERSION,
        });
        const ledgerJsonl = serializeEntries(stampEntries.map(e => e.ledgerEntry));
        const ledgerCompressed = zstdCompress(Buffer.from(ledgerJsonl, 'utf-8'));
        const ledgerResult = await appendBatchLedger(
            { reservationId: reservation.reservationId, entries: stampEntries.map(e => e.ledgerEntry), compressedBuffer: ledgerCompressed },
            { client, bucket }
        );
        ledgerKeys.push(ledgerResult.key);
        console.log(`[TRIAL-STAMP] Batch ${i + 1} ledger PUT ${ledgerResult.key} (${ledgerCompressed.length}B / ${stampEntries.length} entries)`);
        for (const e of stampEntries) {
            newCrosswalkEntries.push(e.crosswalkEntry);
            newlyStampedMap.set(e.trialId, { sid_s: e.sidS, sid_c: e.sidC });
        }
    }

    if (newCrosswalkEntries.length > 0) {
        const cw = await casPutCrosswalk(client, bucket, newCrosswalkEntries);
        console.log(`[TRIAL-STAMP] Crosswalk CAS PUT OK: ${cw.totalEntries} total entries (${cw.byteSize}B zstd, attempts=${cw.attemptsUsed})`);
    } else {
        console.log(`[TRIAL-STAMP] No new crosswalk entries (idempotent re-run)`);
    }

    const stampMap = new Map();
    for (const e of alreadyStamped) stampMap.set(e.trial.id, { sid_s: e.sidS, sid_c: e.sidC });
    for (const [tid, stamp] of newlyStampedMap.entries()) stampMap.set(tid, stamp);

    const { skippedParanoiaCount } = applyStampsToTrials(trials, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[TRIAL-STAMP] HALT: skippedParanoiaCount=${skippedParanoiaCount} — classifier/stampMap drift; non-recoverable without code fix`);
    }

    const output = trials.map(t => JSON.stringify(t)).join('\n') + '\n';
    writeFileSync(TRIALS_PATH, output, 'utf-8');
    console.log(`[TRIAL-STAMP] Wrote ${TRIALS_PATH} with sid_s + sid_c per trial (${Buffer.byteLength(output)}B)`);

    const summary = buildTrialStampingSummary({
        totalTrials: trials.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys,
    });
    console.log(`[TRIAL-STAMP] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
    console.log(`[TRIAL-STAMP] V1.2 STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[TRIAL-STAMP] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
