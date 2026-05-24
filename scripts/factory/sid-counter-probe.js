/**
 * SID Counter Probe — Phase 1.1b live R2 CAS verification.
 *
 * Exercises the Phase 1.1b primitives (sid-counter-ledger + sid-crosswalk)
 * end-to-end against production R2 before Phase 1.1c locks the first
 * batch stamp on cycle 23 compounds-enriched.jsonl (~70K small_molecule).
 *
 * Isolation: uses a sacrificial probe entity_class `probe_sid_v1_0` so
 * production small_molecule / trial / paper counters are NOT polluted.
 * Per V1.0 §40 monotonic invariant, this probe class's counter advances
 * permanently on each run — that's expected.
 *
 * Probe checklist:
 *   1. read counter state (NoSuchKey on first run is OK)
 *   2. reserve a batch via CAS (IfMatch ETag / IfNoneMatch on first PUT)
 *   3. read counter state back — verify advance
 *   4. derive sid_s + sid_c for each counter in batch via Phase 1.1a generators
 *   5. write ledger to state/sid-c-ledger/<rid>.jsonl.zst (single PUT)
 *   6. append crosswalk entries to state/sid-crosswalk/probe_sid_v1_0.jsonl.zst
 *   7. read crosswalk back, lookup by sid_c, verify roundtrip
 *
 * Failure mode: throws + non-zero exit. R2 cleanup is NOT performed —
 * the probe class counter / ledger / crosswalk persist intentionally as
 * audit trail of every CAS verification run.
 */

import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { S3Client } from '@aws-sdk/client-s3';
import {
    reserveCounterBatch, appendBatchLedger, readCounterState, buildLedgerEntry,
} from './lib/sid-counter-ledger.js';
import {
    serializeEntries, validateCrosswalkEntry, putCrosswalkRaw, loadCrosswalkRaw,
    parseCrosswalkJsonl, buildCrosswalkIndex, lookupBySidC, mergeEntries,
} from './lib/sid-crosswalk.js';
import { generateSID_C, generateSID_S } from './lib/sid-generator.js';

const ENTITY_CLASS = 'probe_sid_v1_0';
const CANON_VERSION = 'probe.v1.0';
const WORKER_ID = 'sid-probe-worker';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[SID-probe] missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

function zstd(args, input) {
    const tmpIn = path.join(os.tmpdir(), `sid-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

const zstdCompress = (buf) => zstd(['-f'], buf);
const zstdDecompress = (buf) => zstd(['-d', '-f'], buf);

async function main() {
    const startMs = Date.now();
    const bucket = process.env.R2_BUCKET;
    const batchSize = parseInt(process.env.PROBE_BATCH_SIZE || '100', 10);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw new Error(`[SID-probe] PROBE_BATCH_SIZE must be 1..1000, got ${process.env.PROBE_BATCH_SIZE}`);
    }
    const client = makeR2Client();
    console.log(`[SID-probe] V1.0 CAS verification | entity_class=${ENTITY_CLASS} batch_size=${batchSize}`);

    // 1. read before
    const before = await readCounterState({ client, bucket });
    const counterBefore = before.state.entity_classes[ENTITY_CLASS]?.current_counter || 0;
    console.log(`[SID-probe] Counter before: ${counterBefore} (etag=${before.etag || 'NoSuchKey'})`);

    // 2. CAS reserve
    const issuedAt = new Date().toISOString();
    const { counterStart, counterEnd, reservationId, attemptsUsed } = await reserveCounterBatch(
        { entityClass: ENTITY_CLASS, batchSize, workerId: WORKER_ID, now: issuedAt },
        { client, bucket }
    );
    console.log(`[SID-probe] Reserved [${counterStart}..${counterEnd}] rid=${reservationId} attempts=${attemptsUsed}`);

    // 3. verify counter advance
    const after = await readCounterState({ client, bucket });
    const counterAfter = after.state.entity_classes[ENTITY_CLASS]?.current_counter || 0;
    if (counterAfter !== counterEnd) {
        throw new Error(`[SID-probe] FAIL: counter advance ${counterBefore}->${counterAfter}, expected ${counterEnd}`);
    }
    if (counterAfter !== counterBefore + batchSize) {
        throw new Error(`[SID-probe] FAIL: advance not equal to batchSize`);
    }
    console.log(`[SID-probe] OK: counter advanced ${counterBefore} -> ${counterAfter} (+${batchSize})`);

    // 4. derive entries via Phase 1.1a generators
    const entries = [];
    for (let i = 0; i < batchSize; i++) {
        const counter = counterStart + i;
        const payload = `probe:counter:${counter}`;
        const sidS = generateSID_S(ENTITY_CLASS, payload, CANON_VERSION);
        const sidC = generateSID_C(ENTITY_CLASS, counter);
        entries.push(buildLedgerEntry({
            counterValue: counter, entityClass: ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: payload, canonicalizationVersion: CANON_VERSION,
            reservationId, issuanceAt: issuedAt,
        }));
    }
    entries.forEach(validateCrosswalkEntry);
    console.log(`[SID-probe] Derived ${entries.length} entries via Phase 1.1a generators`);

    // 5. ledger PUT
    const ledgerJsonl = serializeEntries(entries);
    const ledgerCompressed = zstdCompress(Buffer.from(ledgerJsonl, 'utf-8'));
    const ledgerResult = await appendBatchLedger(
        { reservationId, entries, compressedBuffer: ledgerCompressed }, { client, bucket }
    );
    console.log(`[SID-probe] OK: ledger PUT ${ledgerResult.key} (${ledgerCompressed.length}B zstd / ${entries.length} entries)`);

    // 6. crosswalk append (read-merge-write)
    const existing = await loadCrosswalkRaw({ entityClass: ENTITY_CLASS, client, bucket });
    let existingEntries = [];
    if (existing.compressedBuffer) {
        existingEntries = parseCrosswalkJsonl(zstdDecompress(existing.compressedBuffer).toString('utf-8'));
        console.log(`[SID-probe] Existing crosswalk: ${existingEntries.length} entries`);
    } else {
        console.log(`[SID-probe] Crosswalk first-write for ${ENTITY_CLASS}`);
    }
    const allEntries = mergeEntries(existingEntries, entries);
    const crosswalkCompressed = zstdCompress(Buffer.from(serializeEntries(allEntries), 'utf-8'));
    await putCrosswalkRaw({ entityClass: ENTITY_CLASS, compressedBuffer: crosswalkCompressed, client, bucket });
    console.log(`[SID-probe] OK: crosswalk PUT (${allEntries.length} total / ${crosswalkCompressed.length}B zstd)`);

    // 7. crosswalk roundtrip
    const verify = await loadCrosswalkRaw({ entityClass: ENTITY_CLASS, client, bucket });
    const verifyEntries = parseCrosswalkJsonl(zstdDecompress(verify.compressedBuffer).toString('utf-8'));
    if (verifyEntries.length !== allEntries.length) {
        throw new Error(`[SID-probe] FAIL: crosswalk roundtrip length ${verifyEntries.length} != ${allEntries.length}`);
    }
    const index = buildCrosswalkIndex(verifyEntries);
    const lastEntry = entries[entries.length - 1];
    const looked = lookupBySidC(index, lastEntry.sid_c);
    if (!looked || looked.counter_value !== lastEntry.counter_value || looked.sid_s !== lastEntry.sid_s) {
        throw new Error(`[SID-probe] FAIL: crosswalk lookup roundtrip mismatch for sid_c=${lastEntry.sid_c}`);
    }
    console.log(`[SID-probe] OK: crosswalk roundtrip (last sid_c=${lastEntry.sid_c.substring(0, 12)}... resolved)`);

    const elapsed = Math.round((Date.now() - startMs) / 1000);
    console.log(`[SID-probe] === SUMMARY ===`);
    console.log(`  entity_class:     ${ENTITY_CLASS}`);
    console.log(`  batch_size:       ${batchSize}`);
    console.log(`  counter range:    [${counterStart}..${counterEnd}]`);
    console.log(`  counter advance:  ${counterBefore} -> ${counterAfter}`);
    console.log(`  CAS attempts:     ${attemptsUsed}`);
    console.log(`  reservation_id:   ${reservationId}`);
    console.log(`  ledger key:       ${ledgerResult.key}`);
    console.log(`  crosswalk total:  ${allEntries.length}`);
    console.log(`  elapsed:          ${elapsed}s`);
    console.log(`[SID-probe] V1.0 CAS VERIFICATION: SUCCESS`);
}

main().catch(err => {
    console.error(`[SID-probe] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
