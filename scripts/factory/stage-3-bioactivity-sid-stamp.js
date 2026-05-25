/**
 * Stage-3 bioactivity SID stamping orchestrator — Phase 1.5 (cycle 23).
 *
 * Stamps bioactivities.jsonl (~340K records) with sid_s + sid_c per V1.0
 * §35 + §26 bioactivity canonical anchor (ChEMBL activity_id, single-
 * canon). Uses NEW casExecutePartitionedCrosswalkUpdate API (defect-13
 * fix) with isShardingEnabled=false for Phase 1.5 (340K fits single
 * file). Flipping isShardingEnabled=true later requires NO orchestrator
 * changes — shared lib internally partitions additions by sid_s prefix.
 *
 * Failure mode: HARD FAIL.
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
    BIOACTIVITY_ENTITY_CLASS,
    classifyBioactivities, buildBioactivityStampingEntries,
    applyStampsToBioactivities, buildBioactivityStampingSummary,
} from './lib/sid-bioactivity-stamping.js';

const BIOACTIVITIES_PATH = 'output/linked/bioactivities.jsonl';
const LABEL = 'BIOACTIVITY-STAMP';
// Phase 1.5 default: single-file mode. Flip to true (or env-toggle) when
// scale exceeds 10^6 entries per pattern doc §10 forward-look.
const IS_SHARDING_ENABLED = false;

async function main() {
    const startMs = Date.now();
    const client = makeR2Client(LABEL);
    const bucket = process.env.R2_BUCKET;
    console.log(`[${LABEL}] Phase 1.5 stamping | entity_class=${BIOACTIVITY_ENTITY_CLASS} isShardingEnabled=${IS_SHARDING_ENABLED}`);

    const { records: bioactivities, parseErrors } = await readJsonlFile(BIOACTIVITIES_PATH);
    if (parseErrors > 0) throw new Error(`[${LABEL}] bioactivity parse errors: ${parseErrors} - aborting`);
    console.log(`[${LABEL}] Loaded ${bioactivities.length} bioactivities from ${BIOACTIVITIES_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState({ entityClass: BIOACTIVITY_ENTITY_CLASS, client, bucket, label: LABEL });
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[${LABEL}] Crosswalk loaded: ${crosswalkEntries.length} existing entries`);

    const { alreadyStamped, unstamped, unstampable } = classifyBioactivities(bioactivities, crosswalkIndex);
    console.log(`[${LABEL}] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - id=${u.bioactivity?.id} reason=${u.reason}`).join('\n');
        throw new Error(`[${LABEL}] HALT: ${unstampable.length}/${bioactivities.length} bioactivities unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance — upstream chembl-adapter schema gate may have regressed).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
    }

    const ledgerKeys = [];
    const newCrosswalkEntries = [];
    const newlyStampedMap = new Map();
    const plan = planReservations(unstamped.length, DEFAULT_BATCH_SIZE);
    console.log(`[${LABEL}] Reservation plan: ${plan.length} batches (${plan.map(p => p.counterCount).join('+') || '0'})`);

    let cursor = 0;
    let stampedByChembl = 0;
    for (let i = 0; i < plan.length; i++) {
        const { counterCount } = plan[i];
        const issuedAt = new Date().toISOString();
        const reservation = await reserveCounterBatch(
            { entityClass: BIOACTIVITY_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-bioactivity-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[${LABEL}] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildBioactivityStampingEntries({
            unstamped: slice, counterStart: reservation.counterStart,
            reservationId: reservation.reservationId, issuanceAt: issuedAt,
        });
        stampedByChembl += stampEntries.length;
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
            newlyStampedMap.set(e.bioactivityId, { sid_s: e.sidS, sid_c: e.sidC });
        }
    }

    let shardCount = 0;
    if (newCrosswalkEntries.length > 0) {
        const cw = await casExecutePartitionedCrosswalkUpdate({
            entityClass: BIOACTIVITY_ENTITY_CLASS, label: LABEL, client, bucket,
            additions: newCrosswalkEntries, isShardingEnabled: IS_SHARDING_ENABLED,
        });
        shardCount = cw.shardCount;
        const totalAttempts = cw.perShardResults.reduce((s, r) => s + r.attemptsUsed, 0);
        console.log(`[${LABEL}] Partitioned crosswalk update OK: shardCount=${cw.shardCount} totalAttempts=${totalAttempts}`);
    } else {
        console.log(`[${LABEL}] No new crosswalk entries (idempotent re-run)`);
    }

    const stampMap = new Map();
    for (const e of alreadyStamped) stampMap.set(e.bioactivity.id, { sid_s: e.sidS, sid_c: e.sidC });
    for (const [bid, stamp] of newlyStampedMap.entries()) stampMap.set(bid, stamp);

    const { skippedParanoiaCount } = applyStampsToBioactivities(bioactivities, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[${LABEL}] HALT: skippedParanoiaCount=${skippedParanoiaCount} — classifier/stampMap drift`);
    }

    const output = bioactivities.map(b => JSON.stringify(b)).join('\n') + '\n';
    writeFileSync(BIOACTIVITIES_PATH, output, 'utf-8');
    console.log(`[${LABEL}] Wrote ${BIOACTIVITIES_PATH} with sid_s + sid_c per bioactivity (${Buffer.byteLength(output)}B)`);

    const summary = buildBioactivityStampingSummary({
        totalBioactivities: bioactivities.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        stampedByChembl, reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys, shardCount,
    });
    console.log(`[${LABEL}] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
    console.log(`[${LABEL}] V1.5 STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
