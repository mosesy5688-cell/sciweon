/**
 * Stage-3 paper SID stamping orchestrator — Phase 1.3 (cycle 23).
 *
 * Stamps papers.jsonl with sid_s + sid_c per V1.0 §35 + §26 paper anchor
 * (DOI primary, OpenAlex fallback). Multi-canonicalization-version + cross-
 * pollination handling per defects 5 + 5-expanded. Uses shared lib via
 * defect-6-protected callback-based CAS RMW.
 *
 * Failure mode: HARD FAIL.
 */

import crypto from 'crypto';
import { writeFileSync } from 'fs';
import {
    reserveCounterBatch, appendBatchLedger, DEFAULT_BATCH_SIZE,
} from './lib/sid-counter-ledger.js';
import { buildCrosswalkIndex, serializeEntries } from './lib/sid-crosswalk.js';
import { planReservations } from './lib/sid-stamping.js';
import {
    makeR2Client, zstdCompress, readJsonlFile, loadCrosswalkState,
    casExecuteCrosswalkUpdate,
} from './lib/sid-stage3-shared.js';
import {
    PAPER_ENTITY_CLASS,
    classifyPapers, buildPaperStampingEntries,
    buildCrossPollinationEntries, applyStampsToPapers, buildPaperStampingSummary,
    PAPER_CANON_VERSION_DOI,
} from './lib/sid-paper-stamping.js';

const PAPERS_PATH = 'output/linked/papers.jsonl';
const LABEL = 'PAPER-STAMP';

async function main() {
    const startMs = Date.now();
    const client = makeR2Client(LABEL);
    const bucket = process.env.R2_BUCKET;
    console.log(`[${LABEL}] Phase 1.3 stamping | entity_class=${PAPER_ENTITY_CLASS}`);

    const { records: papers, parseErrors } = await readJsonlFile(PAPERS_PATH);
    if (parseErrors > 0) throw new Error(`[${LABEL}] paper parse errors: ${parseErrors} - aborting`);
    console.log(`[${LABEL}] Loaded ${papers.length} papers from ${PAPERS_PATH}`);

    const { entries: crosswalkEntries } = await loadCrosswalkState({ entityClass: PAPER_ENTITY_CLASS, client, bucket, label: LABEL });
    const crosswalkIndex = buildCrosswalkIndex(crosswalkEntries);
    console.log(`[${LABEL}] Crosswalk loaded: ${crosswalkEntries.length} existing entries`);

    const { alreadyStamped, unstamped, unstampable, crossPollination } = classifyPapers(papers, crosswalkIndex);
    console.log(`[${LABEL}] Classified: alreadyStamped=${alreadyStamped.length} unstamped=${unstamped.length} unstampable=${unstampable.length} crossPollination=${crossPollination.length}`);

    if (unstampable.length > 0) {
        const sample = unstampable.slice(0, 10).map(u => `  - id=${u.paper?.id} reason=${u.reason}`).join('\n');
        throw new Error(`[${LABEL}] HALT: ${unstampable.length}/${papers.length} papers unstampable (per [[cross_cycle_silent_data_loss]] zero-tolerance — upstream paper-linker schema gate may have regressed).\nFirst ${Math.min(10, unstampable.length)}:\n${sample}`);
    }

    const ledgerKeys = [];
    const newCrosswalkEntries = [];
    const newlyStampedMap = new Map();
    const plan = planReservations(unstamped.length, DEFAULT_BATCH_SIZE);
    console.log(`[${LABEL}] Reservation plan: ${plan.length} batches (${plan.map(p => p.counterCount).join('+') || '0'})`);

    let cursor = 0;
    let stampedByDoi = 0;
    let stampedByOpenalex = 0;
    for (let i = 0; i < plan.length; i++) {
        const { counterCount } = plan[i];
        const issuedAt = new Date().toISOString();
        const reservation = await reserveCounterBatch(
            { entityClass: PAPER_ENTITY_CLASS, batchSize: counterCount, workerId: 'stage-3-paper-sid-stamp', now: issuedAt },
            { client, bucket }
        );
        console.log(`[${LABEL}] Batch ${i + 1}/${plan.length}: reserved [${reservation.counterStart}..${reservation.counterEnd}] rid=${reservation.reservationId} attempts=${reservation.attemptsUsed}`);
        const slice = unstamped.slice(cursor, cursor + counterCount);
        cursor += counterCount;
        const stampEntries = buildPaperStampingEntries({
            unstamped: slice, counterStart: reservation.counterStart,
            reservationId: reservation.reservationId, issuanceAt: issuedAt,
        });
        for (const e of stampEntries) {
            if (e.anchor.canonVersion === PAPER_CANON_VERSION_DOI) stampedByDoi++;
            else stampedByOpenalex++;
        }
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
            newlyStampedMap.set(e.paperId, { sid_s: e.sidS, sid_c: e.sidC });
        }
    }

    if (crossPollination.length > 0) {
        const crossPollEntries = buildCrossPollinationEntries({
            crossPollination, reservationId: `crosspoll-${crypto.randomUUID()}`,
            issuanceAt: new Date().toISOString(),
        });
        newCrosswalkEntries.push(...crossPollEntries);
        console.log(`[${LABEL}] Cross-pollination: ${crossPollEntries.length} entries (DOI sid_s -> existing sid_c bindings, no new counters)`);
    }

    if (newCrosswalkEntries.length > 0) {
        const cw = await casExecuteCrosswalkUpdate({
            entityClass: PAPER_ENTITY_CLASS, label: LABEL, client, bucket,
            prepareAdditionsFn: async () => newCrosswalkEntries,
        });
        console.log(`[${LABEL}] Crosswalk CAS PUT OK: ${cw.totalEntries} total entries (${cw.byteSize}B zstd, additions=${cw.additionsCount}, attempts=${cw.attemptsUsed})`);
    } else {
        console.log(`[${LABEL}] No new crosswalk entries (idempotent re-run)`);
    }

    const stampMap = new Map();
    for (const e of alreadyStamped) stampMap.set(e.paper.id, { sid_s: e.sidS, sid_c: e.sidC });
    for (const [pid, stamp] of newlyStampedMap.entries()) stampMap.set(pid, stamp);

    const { skippedParanoiaCount } = applyStampsToPapers(papers, stampMap);
    if (skippedParanoiaCount > 0) {
        throw new Error(`[${LABEL}] HALT: skippedParanoiaCount=${skippedParanoiaCount} — classifier/stampMap drift; non-recoverable without code fix`);
    }

    const output = papers.map(p => JSON.stringify(p)).join('\n') + '\n';
    writeFileSync(PAPERS_PATH, output, 'utf-8');
    console.log(`[${LABEL}] Wrote ${PAPERS_PATH} with sid_s + sid_c per paper (${Buffer.byteLength(output)}B)`);

    const summary = buildPaperStampingSummary({
        totalPapers: papers.length, alreadyStamped: alreadyStamped.length,
        newlyStamped: newlyStampedMap.size, unstampable: unstampable.length,
        crossPollinated: crossPollination.length,
        stampedByDoi, stampedByOpenalex,
        reservationsIssued: plan.length, skippedParanoiaCount,
        elapsedMs: Date.now() - startMs, ledgerKeys,
    });
    console.log(`[${LABEL}] === SUMMARY ===`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
    console.log(`[${LABEL}] V1.3 STAMP: SUCCESS`);
}

main().catch(err => {
    console.error(`[${LABEL}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
