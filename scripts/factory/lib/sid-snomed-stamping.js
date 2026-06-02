/**
 * SID SNOMED Stamping -- PR-UMLS-3 pure-function helpers for the snomed_concept
 * entity class (UMLS SNOMED CT US vocabulary, SAB=SNOMEDCT_US).
 *
 * Single-canonical clone of sid-mesh-stamping.js: every SNOMED concept record
 * carries exactly one (anchor_payload, canonicalization_version) pair from the
 * PR-UMLS-3 harvest lib, so the stamper consumes those fields directly with no
 * fallback chain.
 *
 * SID-S anchor (Correction 1, LOCKED): content-addressed on the CODE only --
 * anchor_payload = `SNOMEDCT_US:<CODE>` (record.anchor_payload), NEVER the mutable
 * preferred string ([[content_addressed_anchor_lock]]). canonicalization_version
 * = `snomed.concept.v1.0` is the migration lever. CUI is carried (internally) as
 * the cross-link anchor, NOT the identity key.
 *
 * LICENSE NOTE: this stamper runs on the INTERNAL full SNOMED working copy
 * (output/linked/snomed-concepts.jsonl). The SID-S / SID-C hashes it produces are
 * Sciweon-original, content-addressed, and redistribution-SAFE -- they are the ONLY
 * SNOMED-derived values that reach the PUBLIC snapshot (RULING 1). The proprietary
 * STR + raw CODE + CUI never leave the internal boundary.
 *
 * Stamp-apply key = `code` (DECISION): SNOMED concept records have NO `id` field;
 * the stampMap is keyed by record.code and applyStampsToSnomed keys on it.
 *
 * Hard-fail invariant per [[cross_cycle_silent_data_loss]]: a record missing
 * anchor_payload / canonicalization_version / code routes to `unstampable`; the
 * orchestrator HALTS (zero-tolerance).
 *
 * Frozen reference SID-S pins (computed PR-UMLS-3, entity_class=snomed_concept,
 * canon=snomed.concept.v1.0; NUMERIC SCTIDs only -- NO SNOMED strings in tests):
 *   SNOMEDCT_US:73211009  -> a409595b11d0aabe31aecd559a84e04a
 *   SNOMEDCT_US:38341003  -> b42be5e83138ee10246972aba4ec248d
 *   SNOMEDCT_US:22298006  -> 9bf38a9717b0f8cb09f59abb378948b8
 *   SNOMEDCT_US:195967001 -> 41b646fc894d0240ae2736c9f0a885eb
 * SID-C counter=1 (snomed_concept) -> 6c73f8b801ffc7d25733836ead05408b
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';

export const SNOMED_ENTITY_CLASS = 'snomed_concept';
export const SNOMED_CANON_VERSION = 'snomed.concept.v1.0';
export const UNSTAMPABLE_REASON_MISSING_ANCHOR = 'missing_anchor_metadata';

export function classifySnomedConcepts(concepts, crosswalkIndex) {
    if (!Array.isArray(concepts)) throw new Error('[SID-snomed] concepts must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-snomed] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    for (const concept of concepts) {
        const ap = concept?.anchor_payload;
        const cv = concept?.canonicalization_version;
        const code = concept?.code;
        if (typeof ap !== 'string' || ap.length === 0
            || typeof cv !== 'string' || cv.length === 0
            || typeof code !== 'string' || code.length === 0) {
            unstampable.push({ concept, reason: UNSTAMPABLE_REASON_MISSING_ANCHOR });
            continue;
        }
        const sidS = generateSID_S(SNOMED_ENTITY_CLASS, ap, cv);
        const hit = crosswalkIndex.bySidS.get(sidS);
        if (hit && hit.length > 0) {
            alreadyStamped.push({ concept, sidS, sidC: hit[0].sid_c, anchorPayload: ap, canonVersion: cv });
        } else {
            unstamped.push({ concept, sidS, anchorPayload: ap, canonVersion: cv });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function buildSnomedStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-snomed] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-snomed] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-snomed] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-snomed] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { concept, sidS, anchorPayload, canonVersion } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(SNOMED_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: SNOMED_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchorPayload, canonicalizationVersion: canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: SNOMED_ENTITY_CLASS,
            canonicalization_version: canonVersion,
            canonical_identity_payload: anchorPayload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, code: concept.code });
    }
    return entries;
}

/**
 * Apply stamps keyed by `code` (DECISION: SNOMED records have no `id`). A record
 * whose code is absent from stampMap is the paranoia branch -- the classifier and
 * reservation loop have drifted; surface immediately via the count.
 */
export function applyStampsToSnomed(concepts, stampMap) {
    if (!Array.isArray(concepts)) throw new Error('[SID-snomed] concepts must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-snomed] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const concept of concepts) {
        if (!concept || typeof concept.code === 'undefined') continue;
        const stamp = stampMap.get(concept.code);
        if (!stamp) {
            console.warn(`[SNOMED-STAMP] paranoia miss: code=${concept.code} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        concept.sid_s = stamp.sid_s;
        concept.sid_c = stamp.sid_c;
    }
    return { concepts, skippedParanoiaCount };
}

export function buildSnomedStampingSummary({
    totalConcepts, alreadyStamped, newlyStamped, unstampable,
    reservationsIssued, skippedParanoiaCount, elapsedMs, ledgerKeys, shardCount,
}) {
    return {
        total_concepts: totalConcepts,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable,
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs,
        ledger_keys: ledgerKeys || [],
        shard_count: shardCount,
    };
}
