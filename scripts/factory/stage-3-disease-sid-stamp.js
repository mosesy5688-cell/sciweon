/**
 * Stage-3 disease SID stamping orchestrator — Phase 1.6b (cycle 23).
 *
 * Stamps diseases.jsonl (~47K records in OT 26.03 corpus) with sid_s + sid_c
 * per V1.0 §35 + §26 disease entity-class amendment (architect-locked 2026-05-25).
 * Per-namespace multi-canonicalization-version (Plan A1) — linker (pre.1b) pre-
 * parsed each record's namespace + anchor_payload + canonicalization_version,
 * stamper just consumes those fields and computes sid_s via existing
 * generateSID_S formula.
 *
 * Uses post-defect-13 canonical casExecutePartitionedCrosswalkUpdate API with
 * IS_SHARDING_ENABLED=false (47K fits single-file mode comfortably).
 *
 * Failure mode: HARD FAIL per [[cross_cycle_silent_data_loss]] + architect spec.
 */

import { writeFileSync } from 'fs';
import {
    reserveCounterBatch, appendBatchLedger, DEFAULT_BATCH_SIZE,
} from './lib/sid-counter-ledger.js';
import { buildCrosswalkIndex, serializeEntries } from './lib/sid-crosswalk.js';
import { planReservations } from './lib/sid-stamping.js';
import {
    makeR2Client, zstdCompress, readJsonlFile, loadCrosswalkState,
    casExecutePartitionedCrosswalkUpdate,
} from './lib/sid-stage3-shared.js';
import {
    DISEASE_ENTITY_CLASS,
    classifyDiseases, buildDiseaseStampingEntries,
    applyStampsToDiseases, buildPerCanonVersionCounts, buildDiseaseStampingSummary,
} from './lib/sid-disease-stamping.js';

const DISEASES_PATH = 'output/linked/diseases.jsonl';
const LABEL = 'DISEASE-STAMP';
const IS_SHARDING_ENABLED = false;

async function main() {
    const startMs = Date.now();
    const client = makeR2Client(LABEL);
    const bucket = process.env.R2_BUCKET;
    console.log(`[${LABEL}] Phase 1.6b stamping | entity_class=${DISEASE_ENTITY_CLASS} isShardingEnabled=${IS_SHARDING_ENABLED}`);

    const { records: diseases, parseErrors } = await readJsonlFile(DISEASES_PATH);
    if (parseErrors > 0) throw new Error(`[${LABEL}] disease parse errors: ${parseErrors} - aborting`);
    console.log(`[${LABEL}] Loaded ${diseases.length} diseases from ${DISEASES_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState({ entityClass: DISEASE_ENTITY_CLASS, client, bucket, label: LABEL });
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[${LABEL}] Crosswalk loaded: ${crosswalkEntries.length} existing entries`);

    const { alreadyStamped, unstamped, unstampable } = classifyDiseases(diseases, crosswalkIndex);
    console.log(`[${LABEL}] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - id=${u.disease?.id} reason=${u.reason}`).join('\n');
        throw new Error(`[${LABEL}] HALT: ${unstampable.length}/${diseases.length} diseases unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance — pre.1b linker should have populated anchor_payload + canonicalization_version + namespace on every record; upstream regression suspected).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
    }

    const ledgerKeys = [];
    const newCrosswalkEntries = [];
    const newlyStampedMap = new Map();
    const plan = planReservations(unstamped.length, DEFAULT_BATCH_SIZE);
    console.log(`[${LABEL}] Reservation plan: ${plan.length} batches (${plan.map(p => p.counterCount).join('+') || '0'})`);

    let cursor = 0;
    for (let i = 0; i < plan.length; i++) {
        const { counterCount } = plan[i];
        const issuedAt = new Date().toISOString();
        const reservation = await reserveCounterBatch(
            { entityClass: DISEASE_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-disease-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[${LABEL}] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildDiseaseStampingEntries({
            unstamped: slice, counterStart: reservation.counterStart,
            reservationId: reservation.reservationId, issuanceAt: issuedAt,
        });
        const ledgerJsonl = serializeEntries(stampEntries.map(e => e.ledgerEntry));
        const ledgerCompressed = zstdCompress(Buffer.from(ledgerJsonl, 'utf-8'), LABEL);
        const ledgerResult = await appendBatchLedger(
            { reservationId: reservation.reservationId, entries: stampEntries.map(e => e.ledgerEntry), compressedBuffer: ledgerCompressed },
            { client, bucket }
        );
        ledgerKeys.push(ledgerResult.key);
        console.log(`[${LABEL}] Batch ${i + 1} ledger PUT ${ledgerResult.key} (${ledgerCompressed.length}B / ${stampEntries.length} entries)`);
        for (const e of stampEntries) {
            newCrosswalkEntries.push(e.crosswalkEntry);
            newlyStampedMap.set(e.diseaseId, { sid_s: e.sidS, sid_c: e.sidC });
        }
    }

    let shardCount = 0;
    if (newCrosswalkEntries.length > 0) {
        const cw = await casExecutePartitionedCrosswalkUpdate({
            entityClass: DISEASE_ENTITY_CLASS, label: LABEL, client, bucket,
            additions: newCrosswalkEntries, isShardingEnabled: IS_SHARDING_ENABLED,
        });
        shardCount = cw.shardCount;
        const totalAttempts = cw.perShardResults.reduce((s, r) => s + r.attemptsUsed, 0);
        console.log(`[${LABEL}] Partitioned crosswalk update OK: shardCount=${cw.shardCount} totalAttempts=${totalAttempts}`);
    } else {
        console.log(`[${LABEL}] No new crosswalk entries (idempotent re-run)`);
    }

    const stampMap = new Map();
    for (const e of alreadyStamped) stampMap.set(e.disease.id, { sid_s: e.sidS, sid_c: e.sidC });
    for (const [did, stamp] of newlyStampedMap.entries()) stampMap.set(did, stamp);

    const { skippedParanoiaCount } = applyStampsToDiseases(diseases, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[${LABEL}] HALT: skippedParanoiaCount=${skippedParanoiaCount} — classifier/stampMap drift`);
    }

    // Defect-15 lesson: records.map(...).join('\n') is stack-safe at any size.
    const output = diseases.map(d => JSON.stringify(d)).join('\n') + (diseases.length > 0 ? '\n' : '');
    writeFileSync(DISEASES_PATH, output, 'utf-8');
    console.log(`[${LABEL}] Wrote ${DISEASES_PATH} with sid_s + sid_c per disease (${Buffer.byteLength(output)}B)`);

    const summary = buildDiseaseStampingSummary({
        totalDiseases: diseases.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        perCanonVersionCounts: buildPerCanonVersionCounts(diseases),
        reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys, shardCount,
    });
    console.log(`[${LABEL}] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    console.log(`[${LABEL}] V1.6b STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
