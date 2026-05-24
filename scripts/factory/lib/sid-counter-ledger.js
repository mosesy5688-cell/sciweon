/**
 * SID Counter Ledger — Phase 1.1b R2-persisted monotonic counter operations
 * per V1.0 §40 Distributed-Verifiable Counter Lock + §44 Counter Ingestion
 * Batching Protocol.
 *
 * Pre-Phase-4 design: solo founder controls counter; ledger published to R2
 * at state/sid-c-counter.json (counter state) + state/sid-c-ledger/<rid>.jsonl.zst
 * (per-reservation audit log). Counter is monotonic per entity_class; reserved
 * in batches (default 50000, max 1000000) so that 50K stamps cost 2 R2 ops
 * instead of 100K (per §44 batching).
 *
 * Atomicity: reserveCounterBatch uses S3 conditional PUT (IfMatch ETag) CAS
 * loop. R2 supports S3-spec conditional headers. On 412 PreconditionFailed
 * (concurrent writer beat us), backoff and retry. Pre-Phase-4 invariant is
 * single-writer per entity_class so retries should be rare in practice.
 *
 * Permanence (V1.0 §22): once a counter is issued, it is forever tied to the
 * entity that consumed it. Ledger is append-only. Skipped counters (worker
 * failed before consuming reservation) are NOT reused — monotonic invariant
 * preserved at the cost of small counter-space waste.
 *
 * Semantic Weight Isolation (V1.0 §49): this module carries NO truth weight.
 * Truth lives only in Layer 3 SAL Assertion records. SID-C is a continuity
 * anchor, not a truth value.
 */

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

export const COUNTER_KEY = 'state/sid-c-counter.json';
export const LEDGER_PREFIX = 'state/sid-c-ledger/';
export const DEFAULT_BATCH_SIZE = 50_000;
export const MAX_BATCH_SIZE = 1_000_000;
export const MAX_CAS_RETRIES = 5;
export const RESERVATION_TIMEOUT_HOURS = 24;
export const NAMESPACE = 'sciweon';
export const SPEC_VERSION = '1.0';

function emptyState() {
    return { namespace: NAMESPACE, spec_version: SPEC_VERSION, entity_classes: {}, last_updated: null };
}

export function parseCounterState(jsonStr) {
    if (jsonStr === null || jsonStr === undefined || jsonStr === '') return emptyState();
    const parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
        namespace: parsed.namespace || NAMESPACE,
        spec_version: parsed.spec_version || SPEC_VERSION,
        entity_classes: parsed.entity_classes && typeof parsed.entity_classes === 'object' ? parsed.entity_classes : {},
        last_updated: parsed.last_updated || null,
    };
}

export function validateBatchSize(batchSize) {
    if (typeof batchSize !== 'number' || !Number.isInteger(batchSize)) {
        throw new Error('[SID-counter] batchSize must be integer');
    }
    if (batchSize < 1) throw new Error('[SID-counter] batchSize must be >= 1');
    if (batchSize > MAX_BATCH_SIZE) {
        throw new Error(`[SID-counter] batchSize ${batchSize} exceeds MAX ${MAX_BATCH_SIZE}`);
    }
}

export function computeReservationRange(currentCounter, batchSize) {
    if (typeof currentCounter !== 'number' || !Number.isInteger(currentCounter) || currentCounter < 0) {
        throw new Error('[SID-counter] currentCounter must be non-negative integer');
    }
    validateBatchSize(batchSize);
    const counterStart = currentCounter + 1;
    const counterEnd = currentCounter + batchSize;
    return { counterStart, counterEnd };
}

export function buildReservation({ entityClass, counterStart, counterEnd, reservationId, workerId, now }) {
    if (typeof entityClass !== 'string' || !entityClass) throw new Error('[SID-counter] entityClass required');
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-counter] reservationId required');
    return {
        reservation_id: reservationId,
        entity_class: entityClass,
        counter_start: counterStart,
        counter_end: counterEnd,
        batch_size: counterEnd - counterStart + 1,
        issued_at: now,
        worker_id: workerId || null,
    };
}

export function nextCounterState(prevState, entityClass, batchSize, reservationId, workerId, now) {
    if (typeof entityClass !== 'string' || !entityClass) throw new Error('[SID-counter] entityClass required');
    validateBatchSize(batchSize);
    const state = parseCounterState(prevState);
    const prevBucket = state.entity_classes[entityClass] || { current_counter: 0, last_reservation: null };
    const { counterStart, counterEnd } = computeReservationRange(prevBucket.current_counter, batchSize);
    const reservation = buildReservation({ entityClass, counterStart, counterEnd, reservationId, workerId, now });
    const newState = {
        namespace: NAMESPACE,
        spec_version: SPEC_VERSION,
        entity_classes: { ...state.entity_classes, [entityClass]: { current_counter: counterEnd, last_reservation: reservation } },
        last_updated: now,
    };
    return { newState, reservation, counterStart, counterEnd };
}

export function buildLedgerEntry({ counterValue, entityClass, sidS, sidC, canonicalIdentityPayload, canonicalizationVersion, reservationId, issuanceAt }) {
    if (typeof counterValue !== 'number' || !Number.isInteger(counterValue) || counterValue < 1) {
        throw new Error('[SID-ledger] counterValue must be positive integer');
    }
    if (typeof entityClass !== 'string' || !entityClass) throw new Error('[SID-ledger] entityClass required');
    if (typeof sidS !== 'string' || !sidS) throw new Error('[SID-ledger] sidS required');
    if (typeof sidC !== 'string' || !sidC) throw new Error('[SID-ledger] sidC required');
    if (typeof canonicalIdentityPayload !== 'string' || !canonicalIdentityPayload) throw new Error('[SID-ledger] canonicalIdentityPayload required');
    if (typeof canonicalizationVersion !== 'string' || !canonicalizationVersion) throw new Error('[SID-ledger] canonicalizationVersion required');
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-ledger] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-ledger] issuanceAt required');
    return {
        counter_value: counterValue,
        entity_class: entityClass,
        sid_s: sidS,
        sid_c: sidC,
        canonical_identity_payload: canonicalIdentityPayload,
        canonicalization_version: canonicalizationVersion,
        reservation_id: reservationId,
        issuance_at: issuanceAt,
    };
}

export function ledgerKey(reservationId) {
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-ledger] reservationId required');
    return `${LEDGER_PREFIX}${reservationId}.jsonl.zst`;
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

export async function readCounterState({ client, bucket }) {
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: COUNTER_KEY }));
        const buf = await streamToBuffer(res.Body);
        return { state: parseCounterState(buf.toString('utf-8')), etag: res.ETag };
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return { state: emptyState(), etag: null };
        }
        throw err;
    }
}

function newReservationId() {
    return crypto.randomUUID();
}

function isPreconditionFailed(err) {
    return err?.name === 'PreconditionFailed' || err?.$metadata?.httpStatusCode === 412;
}

async function backoff(attempt) {
    const ms = Math.min(50 * Math.pow(2, attempt), 1000);
    await new Promise(r => setTimeout(r, ms));
}

export async function reserveCounterBatch({ entityClass, batchSize = DEFAULT_BATCH_SIZE, workerId, now }, { client, bucket }) {
    validateBatchSize(batchSize);
    const reservationId = newReservationId();
    const issuedAt = now || new Date().toISOString();
    let lastErr;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
        const { state, etag } = await readCounterState({ client, bucket });
        const { newState, counterStart, counterEnd } = nextCounterState(state, entityClass, batchSize, reservationId, workerId, issuedAt);
        const body = JSON.stringify(newState, null, 2);
        const putParams = { Bucket: bucket, Key: COUNTER_KEY, Body: body, ContentType: 'application/json' };
        if (etag) putParams.IfMatch = etag; else putParams.IfNoneMatch = '*';
        try {
            await client.send(new PutObjectCommand(putParams));
            return { counterStart, counterEnd, reservationId, priorEtag: etag, attemptsUsed: attempt + 1, issuedAt };
        } catch (err) {
            lastErr = err;
            if (!isPreconditionFailed(err)) throw err;
            await backoff(attempt);
        }
    }
    throw new Error(`[SID-counter] CAS failed after ${MAX_CAS_RETRIES} attempts: ${lastErr?.message}`);
}

export async function appendBatchLedger({ reservationId, entries, compressedBuffer }, { client, bucket }) {
    if (!Buffer.isBuffer(compressedBuffer)) {
        throw new Error('[SID-ledger] compressedBuffer (zstd-compressed JSONL) required — compression is caller responsibility per OT-3a CLI shell-out pattern');
    }
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('[SID-ledger] entries non-empty array required');
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: ledgerKey(reservationId),
        Body: compressedBuffer,
        ContentType: 'application/octet-stream',
    }));
    return { key: ledgerKey(reservationId), entryCount: entries.length };
}
