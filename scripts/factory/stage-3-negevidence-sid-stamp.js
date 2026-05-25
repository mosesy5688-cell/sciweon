/**
 * Stage-3 NegEvidence SID stamping orchestrator -- Phase 1.7 (cycle 23).
 *
 * Stamps neg-evidence.jsonl with sid_s + sid_c per V1.0 sec 35 + sec 26
 * negevidence entity-class amendment. 7th Layer-1 stamped class.
 *
 * Plan A1 Per-Type Multi-Canon (7 canon-versions, 1 flat counter bucket).
 * Gamma Stamper-Inline Autonomous Backfill Protocol -- transparently heals
 * legacy records lacking anchor metadata via buildNegAnchorPayload, mutating
 * in-memory so writeback persists healing one-time per gamma protocol.
 *
 * Uses post-defect-13 canonical casExecutePartitionedCrosswalkUpdate with
 * IS_SHARDING_ENABLED=false (111K fits single-file mode).
 *
 * Failure mode: HARD FAIL on unstampable_after_backfill > 0 per
 * [[cross_cycle_silent_data_loss]] -- only records that cannot even be
 * backfilled (truly broken upstream id format) push to unstampable.
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
    NEGEVIDENCE_ENTITY_CLASS,
    classifyNegEvidences, buildNegStampingEntries,
    applyStampsToNegEvidences, buildPerCanonVersionCounts, buildNegEvidenceStampingSummary,
} from './lib/sid-negevidence-stamping.js';

const NEG_EVIDENCE_PATH = 'output/linked/neg-evidence.jsonl';
const LABEL = 'NEG-STAMP';
const IS_SHARDING_ENABLED = false;

async function main() {
    const startMs = Date.now();
    const client = makeR2Client(LABEL);
    const bucket = process.env.R2_BUCKET;
    console.log(`[${LABEL}] Phase 1.7 stamping | entity_class=${NEGEVIDENCE_ENTITY_CLASS} isShardingEnabled=${IS_SHARDING_ENABLED} | gamma backfill ON`);

    const { records, parseErrors } = await readJsonlFile(NEG_EVIDENCE_PATH);
    if (parseErrors > 0) throw new Error(`[${LABEL}] neg-evidence parse errors: ${parseErrors} - aborting`);
    console.log(`[${LABEL}] Loaded ${records.length} neg-evidence records from ${NEG_EVIDENCE_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState({ entityClass: NEGEVIDENCE_ENTITY_CLASS, client, bucket, label: LABEL });
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[${LABEL}] Crosswalk loaded: ${crosswalkEntries.length} existing entries`);

    const { alreadyStamped, unstamped, unstampable, nativelyEnriched, legacyBackfilled } =
        classifyNegEvidences(records, crosswalkIndex);
    console.log(`[${LABEL}] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);
    console.log(`[${LABEL}] Anchor metadata: natively_enriched=${nativelyEnriched} legacy_backfilled=${legacyBackfilled}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - id=${u.record?.id} evidence_type=${u.record?.evidence_type} reason=${u.reason}`).join('\n');
        throw new Error(`[${LABEL}] HALT: ${unstampable.length}/${records.length} records unstampable_after_backfill (per [[cross_cycle_silent_data_loss]] zero-tolerance -- buildNegAnchorPayload could not parse record.id even after backfill attempt; upstream id format regression suspected).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
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
            { entityClass: NEGEVIDENCE_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-negevidence-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[${LABEL}] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildNegStampingEntries({
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
            newlyStampedMap.set(e.recordId, { sid_s: e.sidS, sid_c: e.sidC, uuid: e.uuid });
        }
    }

    let shardCount = 0;
    if (newCrosswalkEntries.length > 0) {
        const cw = await casExecutePartitionedCrosswalkUpdate({
            entityClass: NEGEVIDENCE_ENTITY_CLASS, label: LABEL, client, bucket,
            additions: newCrosswalkEntries, isShardingEnabled: IS_SHARDING_ENABLED,
        });
        shardCount = cw.shardCount;
        const totalAttempts = cw.perShardResults.reduce((s, r) => s + r.attemptsUsed, 0);
        console.log(`[${LABEL}] Partitioned crosswalk update OK: shardCount=${cw.shardCount} totalAttempts=${totalAttempts}`);
    } else {
        console.log(`[${LABEL}] No new crosswalk entries (idempotent re-run)`);
    }

    const stampMap = new Map();
    for (const e of alreadyStamped) stampMap.set(e.record.id, { sid_s: e.sidS, sid_c: e.sidC, uuid: e.uuid });
    for (const [rid, stamp] of newlyStampedMap.entries()) stampMap.set(rid, stamp);

    const { skippedParanoiaCount } = applyStampsToNegEvidences(records, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[${LABEL}] HALT: skippedParanoiaCount=${skippedParanoiaCount} -- classifier/stampMap drift`);
    }

    const output = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
    writeFileSync(NEG_EVIDENCE_PATH, output, 'utf-8');
    console.log(`[${LABEL}] Wrote ${NEG_EVIDENCE_PATH} with sid_s + sid_c + anchor + display_label per record (${Buffer.byteLength(output)}B)`);

    const summary = buildNegEvidenceStampingSummary({
        totalRecords: records.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        nativelyEnriched, legacyBackfilled,
        perCanonVersionCounts: buildPerCanonVersionCounts(records),
        reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys, shardCount,
    });
    console.log(`[${LABEL}] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    console.log(`[${LABEL}] V1.7 STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
