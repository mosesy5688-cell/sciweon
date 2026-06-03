/**
 * Stage-3 LOINC SID stamping orchestrator -- PR-UMLS-4 (loinc_concept entity class).
 *
 * Stamps output/linked/loinc-concepts.jsonl (the measured LNC concept corpus, PR-UMLS-4)
 * with sid_s + sid_c. SID-S = generateSID_S('loinc_concept', record.anchor_payload,
 * record.canonicalization_version) -- content-addressed on `LNC:<CODE>` only (Correction 1),
 * mirroring the SNOMED/MeSH stable-code anchor.
 *
 * This is the FIRST stamp of the loinc_concept class: the counter bucket
 * (sid-counter-ledger.js) + crosswalk file (sid-crosswalk.js) AUTO-PROVISION on the first
 * reserveCounterBatch / loadCrosswalkState call -- no central registry edit (the new-class
 * auto-provision pattern, [[sid_aware_ingest_pattern]]).
 *
 * IS_SHARDING_ENABLED=false: the measured distinct LNC CODE count is << 1e6 per-class ceiling
 * (PR-UMLS-1 distinct-CODE telemetry de-risk; upper bound 306,528). Single-file crosswalk;
 * sharding NOT engaged.
 *
 * LICENSE NOTE: runs on the INTERNAL full LOINC working copy. The sid_s/sid_c it writes are
 * Sciweon-original + redistribution-SAFE; the proprietary CUI in the same in-memory records
 * NEVER reaches the public snapshot (the F3 public builder projects the Cat-0 set
 * {sid_s,sid_c,code,str}; SNAPSHOT_FILES omits the full file).
 *
 * Stamp-apply key = `code` (DECISION): LOINC records have no `id` field.
 *
 * Failure mode: HARD FAIL per [[cross_cycle_silent_data_loss]] -- this orchestrator is the
 * 11th entry of the stage-3-aggregate.js hard-fail stamping loop.
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
    LOINC_ENTITY_CLASS,
    classifyLoincConcepts, buildLoincStampingEntries,
    applyStampsToLoinc, buildLoincStampingSummary,
} from './lib/sid-loinc-stamping.js';

const LOINC_CONCEPTS_PATH = 'output/linked/loinc-concepts.jsonl';
const LABEL = 'LOINC-STAMP';
const IS_SHARDING_ENABLED = false;

async function main() {
    const startMs = Date.now();
    const client = makeR2Client(LABEL);
    const bucket = process.env.R2_BUCKET;
    console.log(`[${LABEL}] PR-UMLS-4 stamping | entity_class=${LOINC_ENTITY_CLASS} isShardingEnabled=${IS_SHARDING_ENABLED}`);

    const { records: concepts, parseErrors } = await readJsonlFile(LOINC_CONCEPTS_PATH);
    if (parseErrors > 0) throw new Error(`[${LABEL}] loinc concept parse errors: ${parseErrors} - aborting`);
    console.log(`[${LABEL}] Loaded ${concepts.length} LOINC concepts from ${LOINC_CONCEPTS_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState({ entityClass: LOINC_ENTITY_CLASS, client, bucket, label: LABEL });
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[${LABEL}] Crosswalk loaded: ${crosswalkEntries.length} existing entries (0 = first-stamp auto-provision)`);

    const { alreadyStamped, unstamped, unstampable } = classifyLoincConcepts(concepts, crosswalkIndex);
    console.log(`[${LABEL}] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - code=${u.concept?.code} reason=${u.reason}`).join('\n');
        throw new Error(`[${LABEL}] HALT: ${unstampable.length}/${concepts.length} concepts unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance -- the harvest lib should populate anchor_payload + canonicalization_version + code on every record; upstream regression suspected).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
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
            { entityClass: LOINC_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-loinc-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[${LABEL}] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildLoincStampingEntries({
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
            newlyStampedMap.set(e.code, { sid_s: e.sidS, sid_c: e.sidC });
        }
    }

    let shardCount = 0;
    if (newCrosswalkEntries.length > 0) {
        const cw = await casExecutePartitionedCrosswalkUpdate({
            entityClass: LOINC_ENTITY_CLASS, label: LABEL, client, bucket,
            additions: newCrosswalkEntries, isShardingEnabled: IS_SHARDING_ENABLED,
        });
        shardCount = cw.shardCount;
        const totalAttempts = cw.perShardResults.reduce((s, r) => s + r.attemptsUsed, 0);
        console.log(`[${LABEL}] Partitioned crosswalk update OK: shardCount=${cw.shardCount} totalAttempts=${totalAttempts}`);
    } else {
        console.log(`[${LABEL}] No new crosswalk entries (idempotent re-run)`);
    }

    const stampMap = new Map();
    for (const e of alreadyStamped) stampMap.set(e.concept.code, { sid_s: e.sidS, sid_c: e.sidC });
    for (const [code, stamp] of newlyStampedMap.entries()) stampMap.set(code, stamp);

    const { skippedParanoiaCount } = applyStampsToLoinc(concepts, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[${LABEL}] HALT: skippedParanoiaCount=${skippedParanoiaCount} -- classifier/stampMap drift`);
    }

    // Defect-15 lesson: records.map(...).join('\n') is stack-safe at any size.
    const output = concepts.map(c => JSON.stringify(c)).join('\n') + (concepts.length > 0 ? '\n' : '');
    writeFileSync(LOINC_CONCEPTS_PATH, output, 'utf-8');
    console.log(`[${LABEL}] Wrote ${LOINC_CONCEPTS_PATH} with sid_s + sid_c per concept (${Buffer.byteLength(output)}B)`);

    const summary = buildLoincStampingSummary({
        totalConcepts: concepts.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys, shardCount,
    });
    console.log(`[${LABEL}] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    console.log(`[${LABEL}] PR-UMLS-4 LOINC STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
