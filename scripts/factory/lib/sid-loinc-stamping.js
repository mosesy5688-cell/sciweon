/**
 * SID LOINC Stamping -- PR-UMLS-4 pure-function helpers for the loinc_concept
 * entity class (UMLS LOINC vocabulary, SAB=LNC).
 *
 * Single-canonical clone of sid-snomed-stamping.js: every LOINC concept record
 * carries exactly one (anchor_payload, canonicalization_version) pair from the
 * PR-UMLS-4 harvest lib, so the stamper consumes those fields directly with no
 * fallback chain.
 *
 * SID-S anchor (Correction 1, LOCKED): content-addressed on the CODE only --
 * anchor_payload = `LNC:<CODE>` (record.anchor_payload), NEVER the mutable
 * preferred string ([[content_addressed_anchor_lock]]). canonicalization_version
 * = `loinc.concept.v1.0` is the migration lever. CUI is carried (internally) as
 * the cross-link anchor, NOT the identity key.
 *
 * LICENSE NOTE: this stamper runs on the INTERNAL full LOINC working copy
 * (output/linked/loinc-concepts.jsonl). The SID-S / SID-C hashes it produces are
 * Sciweon-original, content-addressed, and redistribution-SAFE. The proprietary
 * CUI never leaves the internal boundary; the public artifact is the Cat-0 set
 * {sid_s,sid_c,code,str} (LOINC code+str are redistributable at no cost under the
 * Regenstrief license; only CUI is dropped).
 *
 * Stamp-apply key = `code` (DECISION): LOINC concept records have NO `id` field;
 * the stampMap is keyed by record.code and applyStampsToLoinc keys on it.
 *
 * Hard-fail invariant per [[cross_cycle_silent_data_loss]]: a record missing
 * anchor_payload / canonicalization_version / code routes to `unstampable`; the
 * orchestrator HALTS (zero-tolerance).
 *
 * Frozen reference SID-S pins (computed PR-UMLS-4 with the real generateSID_S,
 * entity_class=loinc_concept, canon=loinc.concept.v1.0; SYNTHETIC code strings):
 *   LNC:34084-4   -> fcb5f8a230b0ae535b7dd7590dad9b22
 *   LNC:2951-2    -> 3c455697051356ac917c15020442f95b
 *   LNC:718-7     -> 11c121ac0d216a075c50936e6b48d178
 *   LNC:2160-0    -> 32268687eee46ade41697c594fa92972
 * SID-C counter=1 (loinc_concept) -> 7bbcc7c95cdb309e1de11b039847b714
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';

export const LOINC_ENTITY_CLASS = 'loinc_concept';
export const LOINC_CANON_VERSION = 'loinc.concept.v1.0';
export const UNSTAMPABLE_REASON_MISSING_ANCHOR = 'missing_anchor_metadata';

export function classifyLoincConcepts(concepts, crosswalkIndex) {
    if (!Array.isArray(concepts)) throw new Error('[SID-loinc] concepts must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-loinc] crosswalkIndex with bySidS map required');
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
        const sidS = generateSID_S(LOINC_ENTITY_CLASS, ap, cv);
        const hit = crosswalkIndex.bySidS.get(sidS);
        if (hit && hit.length > 0) {
            alreadyStamped.push({ concept, sidS, sidC: hit[0].sid_c, anchorPayload: ap, canonVersion: cv });
        } else {
            unstamped.push({ concept, sidS, anchorPayload: ap, canonVersion: cv });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function buildLoincStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-loinc] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-loinc] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-loinc] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-loinc] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { concept, sidS, anchorPayload, canonVersion } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(LOINC_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: LOINC_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchorPayload, canonicalizationVersion: canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: LOINC_ENTITY_CLASS,
            canonicalization_version: canonVersion,
            canonical_identity_payload: anchorPayload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, code: concept.code });
    }
    return entries;
}

/**
 * Apply stamps keyed by `code` (DECISION: LOINC records have no `id`). A record
 * whose code is absent from stampMap is the paranoia branch -- the classifier and
 * reservation loop have drifted; surface immediately via the count.
 */
export function applyStampsToLoinc(concepts, stampMap) {
    if (!Array.isArray(concepts)) throw new Error('[SID-loinc] concepts must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-loinc] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const concept of concepts) {
        if (!concept || typeof concept.code === 'undefined') continue;
        const stamp = stampMap.get(concept.code);
        if (!stamp) {
            console.warn(`[LOINC-STAMP] paranoia miss: code=${concept.code} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        concept.sid_s = stamp.sid_s;
        concept.sid_c = stamp.sid_c;
    }
    return { concepts, skippedParanoiaCount };
}

export function buildLoincStampingSummary({
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
