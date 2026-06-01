/**
 * SID MeSH Stamping -- PR-UMLS-2 pure-function helpers for the mesh_concept
 * entity class (UMLS MeSH vocabulary, SAB=MSH).
 *
 * Single-canonical clone of sid-disease-stamping.js (NOT the cross-pollination
 * target stamper): every MeSH concept record carries exactly one
 * (anchor_payload, canonicalization_version) pair from the PR-1 harvest lib, so
 * the stamper consumes those fields directly with no fallback chain.
 *
 * SID-S anchor (Correction 1, LOCKED): content-addressed on the CODE only --
 * anchor_payload = `MSH:<CODE>` (record.anchor_payload), NEVER the mutable
 * preferred string ([[content_addressed_anchor_lock]]). canonicalization_version
 * = `mesh.concept.v1.0` is the migration lever. CUI is carried as the cross-link
 * anchor (consumed by the F2 mesh-crosslink-enricher), NOT the identity key.
 *
 * Stamp-apply key = `code` (DECISION): MeSH concept records have NO `id` field;
 * the stampMap is keyed by record.code and applyStampsToMesh keys on it.
 *
 * Hard-fail invariant per [[cross_cycle_silent_data_loss]]: a record missing
 * anchor_payload / canonicalization_version / code routes to `unstampable`; the
 * orchestrator HALTS (zero-tolerance -- the PR-1 lib populates all three on every
 * emitted concept; a gap signals upstream regression).
 *
 * Frozen reference SID-S pins (computed PR-UMLS-2, entity_class=mesh_concept,
 * canon=mesh.concept.v1.0):
 *   MSH:D000818 -> 40374b17c32e1493bd60b96c1c2bd2c6
 *   MSH:D012345 -> 33590dc0c9f7bf65f82f66d750278386
 *   MSH:D006801 -> 3c9ce8f59818d3470cd4c1e2163146fa
 *   MSH:D009369 -> 227eb8f6afccbf409fb071b16a994da7
 * SID-C counter=1 (mesh_concept) -> be507120e7ea5dcd273f57761fada499
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';

export const MESH_ENTITY_CLASS = 'mesh_concept';
export const MESH_CANON_VERSION = 'mesh.concept.v1.0';
export const UNSTAMPABLE_REASON_MISSING_ANCHOR = 'missing_anchor_metadata';

export function classifyMeshConcepts(concepts, crosswalkIndex) {
    if (!Array.isArray(concepts)) throw new Error('[SID-mesh] concepts must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-mesh] crosswalkIndex with bySidS map required');
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
        const sidS = generateSID_S(MESH_ENTITY_CLASS, ap, cv);
        const hit = crosswalkIndex.bySidS.get(sidS);
        if (hit && hit.length > 0) {
            alreadyStamped.push({ concept, sidS, sidC: hit[0].sid_c, anchorPayload: ap, canonVersion: cv });
        } else {
            unstamped.push({ concept, sidS, anchorPayload: ap, canonVersion: cv });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function buildMeshStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-mesh] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-mesh] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-mesh] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-mesh] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { concept, sidS, anchorPayload, canonVersion } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(MESH_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: MESH_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchorPayload, canonicalizationVersion: canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: MESH_ENTITY_CLASS,
            canonicalization_version: canonVersion,
            canonical_identity_payload: anchorPayload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, code: concept.code });
    }
    return entries;
}

/**
 * Apply stamps keyed by `code` (DECISION: MeSH records have no `id`). A record
 * whose code is absent from stampMap is the paranoia branch -- the classifier
 * and reservation loop have drifted; surface immediately via the count.
 */
export function applyStampsToMesh(concepts, stampMap) {
    if (!Array.isArray(concepts)) throw new Error('[SID-mesh] concepts must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-mesh] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const concept of concepts) {
        if (!concept || typeof concept.code === 'undefined') continue;
        const stamp = stampMap.get(concept.code);
        if (!stamp) {
            console.warn(`[MESH-STAMP] paranoia miss: code=${concept.code} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        concept.sid_s = stamp.sid_s;
        concept.sid_c = stamp.sid_c;
    }
    return { concepts, skippedParanoiaCount };
}

export function buildMeshStampingSummary({
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
