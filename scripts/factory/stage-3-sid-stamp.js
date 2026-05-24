/**
 * Stage-3 SID stamping orchestrator — Phase 1.1c (cycle 23).
 *
 * Reads output/linked/compounds-enriched.jsonl (post OT-merge, ~69977
 * compounds at cycle 22 closure), stamps each compound with sid_s + sid_c
 * per V1.0 §35 Dual-SID Architecture, persists ledger + crosswalk to R2,
 * rewrites compounds-enriched.jsonl in place.
 *
 * Scaling caveat: this orchestrator's buildCrosswalkIndex is O(N) memory.
 * Pattern lock is correct for entity_classes <= 10^6 entries. Above that
 * scale (Phase 1.5+ bioactivity at ~340K, future academic graph at 10M+),
 * Crosswalk must shard-load or move to KV-service backing. Track as
 * Phase 1.5-scaling debt; not blocking 1.1c on cycle 23 70K compounds.
 *
 * Concurrency: pre-Phase-4 invariant is single-writer per entity_class.
 * Crosswalk PUT uses S3 conditional PUT (IfMatch ETag CAS) per defect-1
 * fix from architect review — protects against retry-overlap / dispatch-
 * collision producing orphan ledger entries.
 *
 * Failure mode: HARD FAIL (non-zero exit). Identity infrastructure cannot
 * have coverage gaps; an unstamped snapshot publication would create a
 * permanent identity black hole in published data.
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
import {
    SMALL_MOLECULE_ENTITY_CLASS, SMALL_MOLECULE_CANON_VERSION,
    classifyCompounds, planReservations, buildStampingEntries,
    applyStampsToCompounds, buildStampingSummary,
} from './lib/sid-stamping.js';

const COMPOUNDS_PATH = 'output/linked/compounds-enriched.jsonl';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[SID-STAMP] missing env: ${missing.join(', ')}`);
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
    const tmpIn = path.join(os.tmpdir(), `sid-stamp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    const { compressedBuffer, etag } = await loadCrosswalkRaw({ entityClass: SMALL_MOLECULE_ENTITY_CLASS, client, bucket });
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
                entityClass: SMALL_MOLECULE_ENTITY_CLASS, compressedBuffer: compressed,
                ...opts, client, bucket,
            });
            return { ...result, totalEntries: merged.length, attemptsUsed: attempt + 1 };
        } catch (err) {
            if (!isPreconditionFailed(err)) throw err;
            console.warn(`[SID-STAMP] crosswalk CAS 412 attempt=${attempt + 1} — reload + retry`);
            await backoff(attempt);
        }
    }
    throw new Error(`[SID-STAMP] crosswalk CAS exhausted after ${MAX_CROSSWALK_CAS_RETRIES} attempts — concurrent writer detected; re-dispatch idempotently`);
}

async function main() {
    const startMs = Date.now();
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;
    console.log(`[SID-STAMP] Phase 1.1c first production stamp | entity_class=${SMALL_MOLECULE_ENTITY_CLASS}`);

    const { records: compounds, parseErrors } = await readJsonlFile(COMPOUNDS_PATH);
    if (parseErrors > 0) throw new Error(`[SID-STAMP] compound parse errors: ${parseErrors} - aborting`);
    console.log(`[SID-STAMP] Loaded ${compounds.length} compounds from ${COMPOUNDS_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState(client, bucket);
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[SID-STAMP] Crosswalk loaded: ${crosswalkEntries.length} existing entries`);

    const { alreadyStamped, unstamped, unstampable } = classifyCompounds(compounds, crosswalkIndex);
    console.log(`[SID-STAMP] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);

    // Zero-tolerance check (defect-2 fix — reachable code, not dead).
    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - id=${u.compound?.id} reason=${u.reason}`).join('\n');
        throw new Error(`[SID-STAMP] HALT: ${unstampable.length}/${compounds.length} compounds unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance — partially_defined_substance routing is Phase 1.2 scope).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
    }

    const ledgerKeys = [];
    const newCrosswalkEntries = [];
    const newlyStampedMap = new Map();
    const plan = planReservations(unstamped.length, DEFAULT_BATCH_SIZE);
    console.log(`[SID-STAMP] Reservation plan: ${plan.length} batches (${plan.map(p => p.counterCount).join('+')})`);

    let cursor = 0;
    for (let i = 0; i < plan.length; i++) {
        const { counterCount } = plan[i];
        const issuedAt = new Date().toISOString();
        const reservation = await reserveCounterBatch(
            { entityClass: SMALL_MOLECULE_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[SID-STAMP] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildStampingEntries({
            unstamped: slice, counterStart: reservation.counterStart,
            reservationId: reservation.reservationId, issuanceAt: issuedAt,
            canonicalizationVersion: SMALL_MOLECULE_CANON_VERSION,
        });
        const ledgerJsonl = serializeEntries(stampEntries.map(e => e.ledgerEntry));
        const ledgerCompressed = zstdCompress(Buffer.from(ledgerJsonl, 'utf-8'));
        const ledgerResult = await appendBatchLedger(
            { reservationId: reservation.reservationId, entries: stampEntries.map(e => e.ledgerEntry), compressedBuffer: ledgerCompressed },
            { client, bucket }
        );
        ledgerKeys.push(ledgerResult.key);
        console.log(`[SID-STAMP] Batch ${i + 1} ledger PUT ${ledgerResult.key} (${ledgerCompressed.length}B / ${stampEntries.length} entries)`);
        for (const e of stampEntries) {
            newCrosswalkEntries.push(e.crosswalkEntry);
            newlyStampedMap.set(e.compoundId, { sid_s: e.sidS, sid_c: e.sidC });
        }
    }

    if (newCrosswalkEntries.length > 0) {
        const cw = await casPutCrosswalk(client, bucket, newCrosswalkEntries);
        console.log(`[SID-STAMP] Crosswalk CAS PUT OK: ${cw.totalEntries} total entries (${cw.byteSize}B zstd, attempts=${cw.attemptsUsed})`);
    } else {
        console.log(`[SID-STAMP] No new crosswalk entries to write (all compounds already stamped — idempotent re-run)`);
    }

    const stampMap = new Map();
    for (const e of alreadyStamped) stampMap.set(e.compound.id, { sid_s: e.sidS, sid_c: e.sidC });
    for (const [cid, stamp] of newlyStampedMap.entries()) stampMap.set(cid, stamp);

    const { skippedParanoiaCount } = applyStampsToCompounds(compounds, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[SID-STAMP] HALT: skippedParanoiaCount=${skippedParanoiaCount} — classifier/stampMap drift; non-recoverable without code fix`);
    }

    const output = compounds.map(c => JSON.stringify(c)).join('\n') + '\n';
    writeFileSync(COMPOUNDS_PATH, output, 'utf-8');
    console.log(`[SID-STAMP] Wrote ${COMPOUNDS_PATH} with sid_s + sid_c per compound (${Buffer.byteLength(output)}B)`);

    const summary = buildStampingSummary({
        totalCompounds: compounds.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys,
    });
    console.log(`[SID-STAMP] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
    console.log(`[SID-STAMP] V1.1c FIRST PRODUCTION STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[SID-STAMP] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
