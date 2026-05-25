/**
 * SID SAL (Scientific Assertion Layer) Stamping — Phase 1.6a per V1.0 §35 + §49.
 *
 * Content-addressed deterministic crypto-anchor (architect-locked 2026-05-25):
 *   Layer 1 anchors for sal_assertion MUST be content-addressed RFC 4122 UUID v5
 *   derived from a 5-field immutable payload. Rejected: semantic-label anchor
 *   (would force Layer 1 to adjudicate NLP normalization, violating §19/§22)
 *   and random UUID (would break Strategic Fork B open-derivability).
 *
 * 5-field canonical payload (lowercased + trimmed, sorted-key JSON):
 *   assertion_class | subject_canonical_sid | predicate | object_canonical_sid | primary_source
 *
 * Per [[cross_cycle_silent_data_loss]] zero-tolerance: missing subject_canonical_sid
 * or object_canonical_sid pushes to unstampable; orchestrator HARD-FAILS.
 *
 * Semantic Weight Isolation (V1.0 §49): SID values are continuity anchors, NOT
 * truth values. Truth lifecycle lives in Layer 5 governance + SER through-time edges.
 */

import crypto from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';

export const SAL_ASSERTION_ENTITY_CLASS = 'sal_assertion';
export const SAL_CANON_VERSION = 'sal.uuid.v1.0';
export const SAL_ANCHOR_PREFIX = 'sal:assertion_v1:';
export const SAL_PAYLOAD_PREFIX = 'assertion_uuid:';
export const UNSTAMPABLE_REASON_MISSING_SUBJECT_SID = 'missing_subject_canonical_sid';
export const UNSTAMPABLE_REASON_MISSING_OBJECT_SID = 'missing_object_canonical_sid';
export const UNSTAMPABLE_REASON_MISSING_PAYLOAD_FIELD = 'missing_payload_field';

/**
 * NAMESPACE_SCIWEON_SAL — RFC 4122-compliant namespace UUID, deterministically
 * derived from sha256("sciweon.sal.namespace.v1") at module load.
 *
 * Bit-slicing intentionally skips hash index 12 ('5' forced, version=5) and
 * index 16 ('9' forced, variant=RFC 4122). Total: 30 hash chars + 2 RFC-4122
 * marker chars = 32 hex + 4 hyphens = 36-char UUID layout.
 *
 * Pinned production value (architect-verified 2026-05-25):
 *   0032aae1-052d-5d09-97b1-5c5b091015dd
 *
 * Sealed by Vitest assertion in sid-sal-stamping.test.ts (Namespace Invariance).
 */
const SEED_HASH = crypto.createHash('sha256').update('sciweon.sal.namespace.v1').digest('hex');
export const NAMESPACE_SCIWEON_SAL = [
    SEED_HASH.slice(0, 8),
    SEED_HASH.slice(8, 12),
    `5${SEED_HASH.slice(13, 16)}`,
    `9${SEED_HASH.slice(17, 20)}`,
    SEED_HASH.slice(20, 32),
].join('-');

const REQUIRED_PAYLOAD_FIELDS = [
    'assertion_class',
    'subject_canonical_sid',
    'predicate',
    'object_canonical_sid',
    'primary_source',
];

export function normalizePayloadField(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.toLowerCase();
}

/**
 * Canonical JSON serialization per architect lock: sorted-key JSON.stringify.
 * Drives UUID v5 derivation; ANY drift here = constitutional break.
 */
export function canonicalSerializePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('[SID-SAL] payload must be object');
    }
    const sortedKeys = Object.keys(payload).sort();
    const sortedObj = {};
    for (const k of sortedKeys) sortedObj[k] = payload[k];
    return JSON.stringify(sortedObj);
}

export function computeSalDeterministicUuid(payload) {
    return uuidv5(canonicalSerializePayload(payload), NAMESPACE_SCIWEON_SAL);
}

/**
 * Validate + normalize a raw assertion into the 5-field canonical payload.
 * Returns { payload, missingField } where missingField is non-null on failure.
 */
export function buildCanonicalPayload(rawAssertion) {
    if (!rawAssertion || typeof rawAssertion !== 'object') {
        return { payload: null, missingField: 'rawAssertion' };
    }
    const payload = {};
    for (const f of REQUIRED_PAYLOAD_FIELDS) {
        const normalized = normalizePayloadField(rawAssertion[f]);
        if (normalized === null) return { payload: null, missingField: f };
        payload[f] = normalized;
    }
    return { payload, missingField: null };
}

export function deriveSalAnchorFromPayload(payload) {
    const uuid = computeSalDeterministicUuid(payload);
    return {
        uuid,
        canonVersion: SAL_CANON_VERSION,
        payload: `${SAL_PAYLOAD_PREFIX}${uuid}`,
        anchor: `${SAL_ANCHOR_PREFIX}${uuid}`,
    };
}

/**
 * Separates rawAssertions into alreadyStamped / unstamped / unstampable.
 * Hard-fail invariant: missing subject/object SID-S routes to unstampable;
 * orchestrator MUST HALT before any R2 mutation.
 */
export function classifyAssertions(rawAssertions, salCrosswalkIndex) {
    if (!Array.isArray(rawAssertions)) throw new Error('[SID-SAL] rawAssertions must be array');
    if (!salCrosswalkIndex || !salCrosswalkIndex.bySidS) {
        throw new Error('[SID-SAL] salCrosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    for (const raw of rawAssertions) {
        const { payload, missingField } = buildCanonicalPayload(raw);
        if (!payload) {
            let reason = UNSTAMPABLE_REASON_MISSING_PAYLOAD_FIELD;
            if (missingField === 'subject_canonical_sid') reason = UNSTAMPABLE_REASON_MISSING_SUBJECT_SID;
            else if (missingField === 'object_canonical_sid') reason = UNSTAMPABLE_REASON_MISSING_OBJECT_SID;
            unstampable.push({ rawAssertion: raw, reason, missingField });
            continue;
        }
        const anchor = deriveSalAnchorFromPayload(payload);
        const sidS = generateSID_S(SAL_ASSERTION_ENTITY_CLASS, anchor.payload, anchor.canonVersion);
        const hit = salCrosswalkIndex.bySidS.get(sidS);
        if (hit && hit.length > 0) {
            alreadyStamped.push({ rawAssertion: raw, payload, anchor, sidS, sidC: hit[0].sid_c });
        } else {
            unstamped.push({ rawAssertion: raw, payload, anchor, sidS });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function buildSalStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-SAL] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-SAL] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-SAL] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-SAL] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { rawAssertion, payload, anchor, sidS } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(SAL_ASSERTION_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: SAL_ASSERTION_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchor.payload, canonicalizationVersion: anchor.canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: SAL_ASSERTION_ENTITY_CLASS,
            canonicalization_version: anchor.canonVersion,
            canonical_identity_payload: anchor.payload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, rawAssertion, payload, anchor });
    }
    return entries;
}

/**
 * Locked output row schema (architect double-track contract — Defect-14 prevention).
 * display_label is read-only Debug-isolation band; downstream consumers MUST NEVER
 * key on it (allowed to drift with LLM/NLP rule changes).
 */
export function buildOutputRow({ sidS, sidC, anchor, payload, displayContext }) {
    const subjectSymbol = displayContext?.subject_label || payload.subject_canonical_sid;
    const objectSymbol = displayContext?.object_label || payload.object_canonical_sid;
    return {
        sid_s: sidS,
        sid_c: sidC,
        anchor: anchor.anchor,
        display_label: `[${payload.assertion_class.toUpperCase()}] ${subjectSymbol} -> ${payload.predicate} -> ${objectSymbol} (via ${payload.primary_source})`,
        payload: {
            assertion_class: payload.assertion_class,
            subject_canonical_sid: payload.subject_canonical_sid,
            predicate: payload.predicate,
            object_canonical_sid: payload.object_canonical_sid,
            primary_source: payload.primary_source,
        },
    };
}

export function buildSalStampingSummary({
    totalAssertions, alreadyStamped, newlyStamped, unstampable,
    perClassCounts, perBuilderCounts, reservationsIssued, skippedParanoiaCount,
    elapsedMs, ledgerKeys, shardCount,
}) {
    return {
        total_assertions: totalAssertions,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable,
        per_class_counts: perClassCounts || {},
        per_builder_counts: perBuilderCounts || {},
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs,
        ledger_keys: ledgerKeys || [],
        shard_count: shardCount,
    };
}
