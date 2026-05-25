/**
 * Stage-3 SAL SID stamping orchestrator — Phase 1.6a (cycle 23).
 *
 * Stamps Scientific Assertion Layer records with sid_s + sid_c per V1.0 §35 + §49.
 * Content-addressed deterministic UUID v5 anchor (architect-locked 2026-05-25).
 *
 * Unified-stream contract (architect-locked): accepts an ARRAY of assertion-source
 * builders. Phase 1.6a wires bioactivity-builder only; Phase 1.6c will add
 * ot-indication-builder additively (one-line edit). Single classify / single
 * reserveCounterBatch / single casExecutePartitionedCrosswalkUpdate / single
 * sal-assertions.jsonl write — R2 cost stays O(1) in source-count.
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
    makeR2Client, zstdCompress, loadCrosswalkState,
    casExecutePartitionedCrosswalkUpdate,
} from './lib/sid-stage3-shared.js';
import {
    SAL_ASSERTION_ENTITY_CLASS,
    classifyAssertions, buildSalStampingEntries, buildOutputRow, buildSalStampingSummary,
    mergeBuilderRawAssertions,
} from './lib/sid-sal-stamping.js';
import { buildBioactivityAssertions, BUILDER_LABEL as BIOACT_BUILDER_LABEL } from './lib/sal-bioactivity-builder.js';

const SAL_ASSERTIONS_PATH = 'output/linked/sal-assertions.jsonl';
const LABEL = 'SAL-STAMP';
const IS_SHARDING_ENABLED = false;

// Phase 1.6a: bioactivity-builder only. Phase 1.6c will add ot-indication-builder
// additively. Each entry: { label, fn } where fn returns { rawAssertions[], stats }.
const ASSERTION_BUILDERS = [
    { label: BIOACT_BUILDER_LABEL, fn: () => buildBioactivityAssertions() },
];

async function main() {
    const startMs = Date.now();
    const client = makeR2Client(LABEL);
    const bucket = process.env.R2_BUCKET;
    console.log(`[${LABEL}] Phase 1.6a stamping | entity_class=${SAL_ASSERTION_ENTITY_CLASS} isShardingEnabled=${IS_SHARDING_ENABLED} builders=${ASSERTION_BUILDERS.length}`);

    const perBuilderCounts = {};
    const builderResults = [];
    for (const { label, fn } of ASSERTION_BUILDERS) {
        const { rawAssertions, stats } = await fn();
        perBuilderCounts[label] = stats.emitted;
        builderResults.push({ rawAssertions });
        console.log(`[${LABEL}] Builder ${label}: emitted=${stats.emitted}`);
    }
    // Defect-15 fix: for-loop merge (NOT spread-push) — spread-push blows the
    // JS argument stack at ~100K elements.
    const allRawAssertions = mergeBuilderRawAssertions(builderResults);
    console.log(`[${LABEL}] Unified stream: ${allRawAssertions.length} raw assertions across ${ASSERTION_BUILDERS.length} builder(s)`);

    const { entries: crosswalkEntries } = await loadCrosswalkState({ entityClass: SAL_ASSERTION_ENTITY_CLASS, client, bucket, label: LABEL });
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[${LABEL}] Crosswalk loaded: ${crosswalkEntries.length} existing entries`);

    const { alreadyStamped, unstamped, unstampable } = classifyAssertions(allRawAssertions, crosswalkIndex);
    console.log(`[${LABEL}] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - source_record_id=${u.rawAssertion?.source_record_id} reason=${u.reason} missingField=${u.missingField}`).join('\n');
        throw new Error(`[${LABEL}] HALT: ${unstampable.length}/${allRawAssertions.length} assertions unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance + architect hard-fail spec — upstream builder failed to resolve subject/object Layer 1 SID-S, indicating compound/target crosswalk drift).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
    }

    const ledgerKeys = [];
    const newCrosswalkEntries = [];
    const newlyStampedEntries = [];
    const plan = planReservations(unstamped.length, DEFAULT_BATCH_SIZE);
    console.log(`[${LABEL}] Reservation plan: ${plan.length} batches (${plan.map(p => p.counterCount).join('+') || '0'})`);

    let cursor = 0;
    for (let i = 0; i < plan.length; i++) {
        const { counterCount } = plan[i];
        const issuedAt = new Date().toISOString();
        const reservation = await reserveCounterBatch(
            { entityClass: SAL_ASSERTION_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-sal-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[${LABEL}] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildSalStampingEntries({
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
            newlyStampedEntries.push(e);
        }
    }

    let shardCount = 0;
    if (newCrosswalkEntries.length > 0) {
        const cw = await casExecutePartitionedCrosswalkUpdate({
            entityClass: SAL_ASSERTION_ENTITY_CLASS, label: LABEL, client, bucket,
            additions: newCrosswalkEntries, isShardingEnabled: IS_SHARDING_ENABLED,
        });
        shardCount = cw.shardCount;
        const totalAttempts = cw.perShardResults.reduce((s, r) => s + r.attemptsUsed, 0);
        console.log(`[${LABEL}] Partitioned crosswalk update OK: shardCount=${cw.shardCount} totalAttempts=${totalAttempts}`);
    } else {
        console.log(`[${LABEL}] No new crosswalk entries (idempotent re-run)`);
    }

    const outputRows = [];
    const perClassCounts = {};
    for (const e of alreadyStamped) {
        outputRows.push(buildOutputRow({
            sidS: e.sidS, sidC: e.sidC, anchor: e.anchor, payload: e.payload,
            displayContext: e.rawAssertion.display_context,
        }));
        perClassCounts[e.payload.assertion_class] = (perClassCounts[e.payload.assertion_class] || 0) + 1;
    }
    for (const e of newlyStampedEntries) {
        outputRows.push(buildOutputRow({
            sidS: e.sidS, sidC: e.sidC, anchor: e.anchor, payload: e.payload,
            displayContext: e.rawAssertion.display_context,
        }));
        perClassCounts[e.payload.assertion_class] = (perClassCounts[e.payload.assertion_class] || 0) + 1;
    }

    const totalExpected = alreadyStamped.length + newlyStampedEntries.length;
    if (outputRows.length !== totalExpected) {
        throw new Error(`[${LABEL}] HALT: outputRows=${outputRows.length} != expected=${totalExpected} — classifier/builder drift`);
    }

    const body = outputRows.map(r => JSON.stringify(r)).join('\n') + (outputRows.length > 0 ? '\n' : '');
    writeFileSync(SAL_ASSERTIONS_PATH, body, 'utf-8');
    console.log(`[${LABEL}] Wrote ${SAL_ASSERTIONS_PATH} (${outputRows.length} rows, ${Buffer.byteLength(body)}B)`);

    const summary = buildSalStampingSummary({
        totalAssertions: allRawAssertions.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedEntries.length, unstampable: unstampable.length,
        perClassCounts, perBuilderCounts, reservationsIssued: plan.length, skippedParanoiaCount: 0,
        elapsedMs: Date.now() - startMs, ledgerKeys, shardCount,
    });
    console.log(`[${LABEL}] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    console.log(`[${LABEL}] V1.6a STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
