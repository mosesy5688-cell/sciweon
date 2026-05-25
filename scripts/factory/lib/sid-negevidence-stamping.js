/**
 * SID NegEvidence Stamping -- Phase 1.7 per V1.0 sec 35 + 49 + Plan A1 lock 2026-05-25.
 *
 * 7th Layer-1 stamped entity class. SAL-style content-addressed UUID v5 anchor
 * pattern with per-evidence_type multi-canon (7 canon-versions) all funneling
 * through ONE flat negevidence counter bucket.
 *
 * Gamma (Stamper-Inline Autonomous Backfill Protocol) -- user lock 2026-05-25
 * post continuation 37 R2 anchor-gap discovery: classifyNegEvidences checks
 * anchor metadata; if missing on legacy records, transparently backfills via
 * buildNegAnchorPayload. The backfilled triple is written back into the record
 * IN MEMORY so the final writeFileSync persists the healing -- one-time legacy
 * debt cleared cycle 23 / Phase 1.7.
 *
 * NAMESPACE_SCIWEON_NEG (execution-gate-verified 2026-05-25):
 *   1b2729f6-2056-59a4-9ca6-3aed64ca2824
 *   = sha256("sciweon.negevidence.namespace.v1") + RFC4122 v5+9 bit-slice
 *
 * 7 frozen SID-S pins (production-anchored from F3 run 26399491661):
 *   inactive_bioassay (CHEMBL_ACT_22084310)      -> 9dc0e97434a4f19eb89c8a649897c404
 *   faers_adr_signal (CID:5002::toxicity_...)    -> 232818ad2c121561e09677028306a448
 *   drug_withdrawal (CID:237)                    -> a3c2836c03e789b42fdf1dc4673fa47a
 *   black_box_warning (CID:5002)                 -> e3676c609175e4c4adbdf0e1d71cbc0a
 *   serious_adverse_event_per_trial (NCT00683618)-> ab0a46f5e05179dd942921f4d325d8f0
 *   trial_failure (NCT03952598)                  -> 5e023e65cd57c8ed89848331b927e298
 *   paper_retraction (10.1016_s0140_6736_20_..)  -> 68ff89d770599067fa6bdc9d4f2b2487
 *   counter=1 sid_c                              -> fb65ec16d601707c9b100aa72595fee3
 */

import crypto from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';
import {
    NEG_EVIDENCE_TYPES, NEG_EVIDENCE_CANON_VERSIONS,
    NEGEVIDENCE_NAMESPACE, buildNegAnchorPayload,
} from '../../../src/lib/schemas/neg-evidence-types.js';

export const NEGEVIDENCE_ENTITY_CLASS = 'negevidence';
export const SAL_ANCHOR_DISPLAY_PREFIX = 'sal:negevidence_v1:';
export const SAL_PAYLOAD_PREFIX = 'assertion_uuid:';
export const UNSTAMPABLE_REASON_MISSING_ANCHOR_AFTER_BACKFILL = 'missing_anchor_metadata_after_backfill';
export { NEG_EVIDENCE_CANON_VERSIONS, NEGEVIDENCE_NAMESPACE, buildNegAnchorPayload };

const SEED_HASH = crypto.createHash('sha256').update('sciweon.negevidence.namespace.v1').digest('hex');
export const NAMESPACE_SCIWEON_NEG = [
    SEED_HASH.slice(0, 8),
    SEED_HASH.slice(8, 12),
    `5${SEED_HASH.slice(13, 16)}`,
    `9${SEED_HASH.slice(17, 20)}`,
    SEED_HASH.slice(20, 32),
].join('-');

export function canonicalSerializePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('[SID-NEG] payload must be object');
    const sortedKeys = Object.keys(payload).sort();
    const sortedObj = {};
    for (const k of sortedKeys) sortedObj[k] = payload[k];
    return JSON.stringify(sortedObj);
}

export function computeNegDeterministicUuid(payload) {
    return uuidv5(canonicalSerializePayload(payload), NAMESPACE_SCIWEON_NEG);
}

/**
 * Gamma backfill: validate or restore the 3-field anchor metadata on a single
 * record. Returns { ok: true, anchor: {namespace, anchor_payload, canon},
 * mutated: bool } on success or { ok: false } on hopeless input.
 *
 * On backfill success, mutates record in-memory so writeFileSync persists the
 * healed metadata (one-time legacy debt clearing per gamma protocol).
 */
export function ensureAnchorMetadata(record) {
    let { namespace, anchor_payload, canonicalization_version } = record;
    if (typeof namespace === 'string' && namespace.length > 0
        && typeof anchor_payload === 'string' && anchor_payload.length > 0
        && typeof canonicalization_version === 'string' && canonicalization_version.length > 0) {
        return { ok: true, anchor: { namespace, anchor_payload, canonicalization_version }, mutated: false };
    }
    const restored = buildNegAnchorPayload(record);
    if (!restored) return { ok: false };
    record.namespace = restored.namespace;
    record.anchor_payload = restored.anchor_payload;
    record.canonicalization_version = restored.canonicalization_version;
    return { ok: true, anchor: restored, mutated: true };
}

export function classifyNegEvidences(records, crosswalkIndex) {
    if (!Array.isArray(records)) throw new Error('[SID-NEG] records must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-NEG] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    let nativelyEnriched = 0;
    let legacyBackfilled = 0;
    for (const record of records) {
        const meta = ensureAnchorMetadata(record);
        if (!meta.ok) {
            unstampable.push({ record, reason: UNSTAMPABLE_REASON_MISSING_ANCHOR_AFTER_BACKFILL });
            continue;
        }
        if (meta.mutated) legacyBackfilled++; else nativelyEnriched++;
        const payload = {
            evidence_type: record.evidence_type,
            clean_id_tail: meta.anchor.anchor_payload,
            canonicalization_version: meta.anchor.canonicalization_version,
        };
        const uuid = computeNegDeterministicUuid(payload);
        const anchorPayload = `${SAL_PAYLOAD_PREFIX}${uuid}`;
        const sidS = generateSID_S(NEGEVIDENCE_ENTITY_CLASS, anchorPayload, meta.anchor.canonicalization_version);
        const hit = crosswalkIndex.bySidS.get(sidS);
        if (hit && hit.length > 0) {
            alreadyStamped.push({ record, sidS, sidC: hit[0].sid_c, uuid, payload, canonVersion: meta.anchor.canonicalization_version });
        } else {
            unstamped.push({ record, sidS, uuid, payload, canonVersion: meta.anchor.canonicalization_version });
        }
    }
    return { alreadyStamped, unstamped, unstampable, nativelyEnriched, legacyBackfilled };
}

export function buildNegStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-NEG] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-NEG] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-NEG] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-NEG] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { record, sidS, uuid, canonVersion } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(NEGEVIDENCE_ENTITY_CLASS, counter);
        const canonPayload = `${SAL_PAYLOAD_PREFIX}${uuid}`;
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: NEGEVIDENCE_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: canonPayload, canonicalizationVersion: canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: NEGEVIDENCE_ENTITY_CLASS,
            canonicalization_version: canonVersion,
            canonical_identity_payload: canonPayload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, uuid, ledgerEntry, crosswalkEntry, recordId: record.id });
    }
    return entries;
}

export function applyStampsToNegEvidences(records, stampMap) {
    if (!Array.isArray(records)) throw new Error('[SID-NEG] records must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-NEG] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const record of records) {
        if (!record || typeof record.id === 'undefined') continue;
        const stamp = stampMap.get(record.id);
        if (!stamp) {
            console.warn(`[NEG-STAMP] paranoia miss: id=${record.id} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        record.sid_s = stamp.sid_s;
        record.sid_c = stamp.sid_c;
        record.anchor = `${SAL_ANCHOR_DISPLAY_PREFIX}${stamp.uuid}`;
        record.display_label = `[NEG_EVIDENCE:${(record.evidence_type || 'UNKNOWN').toUpperCase()}] ${record.id} (via ${record.provenance?.primary_source ?? 'unknown_source'})`;
    }
    return { records, skippedParanoiaCount };
}

export function buildPerCanonVersionCounts(records) {
    const counts = {};
    for (const ev of NEG_EVIDENCE_TYPES) counts[ev] = 0;
    for (const r of records) {
        if (r && typeof r.evidence_type === 'string' && Object.prototype.hasOwnProperty.call(counts, r.evidence_type)) {
            counts[r.evidence_type]++;
        }
    }
    return counts;
}

export function buildNegEvidenceStampingSummary({
    totalRecords, alreadyStamped, newlyStamped, unstampable,
    nativelyEnriched, legacyBackfilled,
    perCanonVersionCounts, reservationsIssued, skippedParanoiaCount,
    elapsedMs, ledgerKeys, shardCount,
}) {
    return {
        total_processed_records: totalRecords,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable_after_backfill: unstampable,
        natively_enriched_current_cycle: nativelyEnriched,
        legacy_records_autonomously_backfilled: legacyBackfilled,
        per_canon_version_counts: perCanonVersionCounts || {},
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs,
        ledger_keys: ledgerKeys || [],
        shard_count: shardCount,
    };
}
