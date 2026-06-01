/**
 * Stage-3 MeSH SID stamping orchestrator -- PR-UMLS-2 (mesh_concept entity class).
 *
 * Stamps output/linked/mesh-concepts.jsonl (~355K MSH concepts, PR-1 corpus) with
 * sid_s + sid_c. SID-S = generateSID_S('mesh_concept', record.anchor_payload,
 * record.canonicalization_version) -- content-addressed on `MSH:<CODE>` only
 * (Correction 1), mirroring the disease stamper's stable-code anchor.
 *
 * This is the FIRST stamp of the mesh_concept class: the counter bucket
 * (sid-counter-ledger.js) + crosswalk file (sid-crosswalk.js) AUTO-PROVISION on
 * the first reserveCounterBatch / loadCrosswalkState call -- no central registry
 * edit (the new-class auto-provision pattern, [[sid_aware_ingest_pattern]]).
 *
 * IS_SHARDING_ENABLED=false: 355K << 1e6 per-class ceiling (PR-1 distinct-CODE
 * telemetry de-risk confirmed). Single-file crosswalk; sharding NOT engaged.
 *
 * Stamp-apply key = `code` (DECISION): MeSH records have no `id` field.
 *
 * Failure mode: HARD FAIL per [[cross_cycle_silent_data_loss]] -- this orchestrator
 * is the 9th entry of the stage-3-aggregate.js hard-fail stamping loop.
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
    MESH_ENTITY_CLASS,
    classifyMeshConcepts, buildMeshStampingEntries,
    applyStampsToMesh, buildMeshStampingSummary,
} from './lib/sid-mesh-stamping.js';

const MESH_CONCEPTS_PATH = 'output/linked/mesh-concepts.jsonl';
const LABEL = 'MESH-STAMP';
const IS_SHARDING_ENABLED = false;

async function main() {
    const startMs = Date.now();
    const client = makeR2Client(LABEL);
    const bucket = process.env.R2_BUCKET;
    console.log(`[${LABEL}] PR-UMLS-2 stamping | entity_class=${MESH_ENTITY_CLASS} isShardingEnabled=${IS_SHARDING_ENABLED}`);

    const { records: concepts, parseErrors } = await readJsonlFile(MESH_CONCEPTS_PATH);
    if (parseErrors > 0) throw new Error(`[${LABEL}] mesh concept parse errors: ${parseErrors} - aborting`);
    console.log(`[${LABEL}] Loaded ${concepts.length} MeSH concepts from ${MESH_CONCEPTS_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState({ entityClass: MESH_ENTITY_CLASS, client, bucket, label: LABEL });
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[${LABEL}] Crosswalk loaded: ${crosswalkEntries.length} existing entries (0 = first-stamp auto-provision)`);

    const { alreadyStamped, unstamped, unstampable } = classifyMeshConcepts(concepts, crosswalkIndex);
    console.log(`[${LABEL}] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - code=${u.concept?.code} reason=${u.reason}`).join('\n');
        throw new Error(`[${LABEL}] HALT: ${unstampable.length}/${concepts.length} concepts unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance -- PR-1 harvest lib should populate anchor_payload + canonicalization_version + code on every record; upstream regression suspected).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
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
            { entityClass: MESH_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-mesh-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[${LABEL}] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildMeshStampingEntries({
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
            entityClass: MESH_ENTITY_CLASS, label: LABEL, client, bucket,
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

    const { skippedParanoiaCount } = applyStampsToMesh(concepts, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[${LABEL}] HALT: skippedParanoiaCount=${skippedParanoiaCount} -- classifier/stampMap drift`);
    }

    // Defect-15 lesson: records.map(...).join('\n') is stack-safe at any size.
    const output = concepts.map(c => JSON.stringify(c)).join('\n') + (concepts.length > 0 ? '\n' : '');
    writeFileSync(MESH_CONCEPTS_PATH, output, 'utf-8');
    console.log(`[${LABEL}] Wrote ${MESH_CONCEPTS_PATH} with sid_s + sid_c per concept (${Buffer.byteLength(output)}B)`);

    const summary = buildMeshStampingSummary({
        totalConcepts: concepts.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys, shardCount,
    });
    console.log(`[${LABEL}] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    console.log(`[${LABEL}] PR-UMLS-2 MESH STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
