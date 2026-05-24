/**
 * SID Stamping — Phase 1.1c pure-function helpers for stage-3 batch
 * stamping per V1.0 §35 Dual-SID + §44 Counter Ingestion Batching.
 *
 * Design invariant (defect-2 fix from architect review): classification
 * NEVER throws on data-shape conditions. Compounds with missing/invalid
 * InChIKey are pushed to `unstampable` with a `reason` field; the
 * orchestrator inspects the partition AFTER classification and applies
 * graduated zero-tolerance response. This keeps the production safety
 * harness as reachable code, not dead code shielded by an early throw.
 *
 * Phase 1.1c scope: small_molecule entity_class only. Compounds without
 * InChIKey are flagged as unstampable (Phase 1.2+ adds partially_defined_-
 * substance routing per V1.0 §27 Anti-Over-Collapsing Doctrine).
 *
 * Semantic Weight Isolation (V1.0 §49): this module injects identity
 * infrastructure (sid_s + sid_c), zero truth weight. Truth lives only in
 * Layer 3 SAL Assertion records.
 */

import {
    generateSID_S, generateSID_C, smallMoleculeCanonicalAnchor,
    SMALL_MOLECULE_CANONICALIZATION_VERSION,
} from './sid-generator.js';
import { buildLedgerEntry, DEFAULT_BATCH_SIZE } from './sid-counter-ledger.js';

export const SMALL_MOLECULE_ENTITY_CLASS = 'small_molecule';
export const SMALL_MOLECULE_CANON_VERSION = SMALL_MOLECULE_CANONICALIZATION_VERSION;
export const UNSTAMPABLE_REASON_MISSING_INCHIKEY = 'missing_inchi_key';

export function deriveSmallMoleculeSidS(inchiKey) {
    if (typeof inchiKey !== 'string' || inchiKey.length === 0) {
        throw new Error('[SID-stamp] deriveSmallMoleculeSidS: inchiKey required non-empty string');
    }
    const anchor = smallMoleculeCanonicalAnchor(inchiKey);
    return generateSID_S(SMALL_MOLECULE_ENTITY_CLASS, anchor, SMALL_MOLECULE_CANON_VERSION);
}

function hasValidInchiKey(compound) {
    return compound && typeof compound.inchi_key === 'string' && compound.inchi_key.length > 0;
}

export function classifyCompounds(compounds, crosswalkIndex) {
    if (!Array.isArray(compounds)) throw new Error('[SID-stamp] compounds must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-stamp] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    for (const compound of compounds) {
        if (!hasValidInchiKey(compound)) {
            unstampable.push({ compound, reason: UNSTAMPABLE_REASON_MISSING_INCHIKEY });
            continue;
        }
        const sidS = deriveSmallMoleculeSidS(compound.inchi_key);
        const existing = crosswalkIndex.bySidS.get(sidS);
        if (existing && existing.length > 0) {
            const entry = existing[0];
            alreadyStamped.push({ compound, sidS, sidC: entry.sid_c });
        } else {
            unstamped.push({ compound, sidS });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function planReservations(unstampedCount, batchSize = DEFAULT_BATCH_SIZE) {
    if (typeof unstampedCount !== 'number' || !Number.isInteger(unstampedCount) || unstampedCount < 0) {
        throw new Error('[SID-stamp] unstampedCount must be non-negative integer');
    }
    if (typeof batchSize !== 'number' || !Number.isInteger(batchSize) || batchSize < 1) {
        throw new Error('[SID-stamp] batchSize must be positive integer');
    }
    if (unstampedCount === 0) return [];
    const plan = [];
    let remaining = unstampedCount;
    while (remaining > 0) {
        const counterCount = Math.min(batchSize, remaining);
        plan.push({ counterCount });
        remaining -= counterCount;
    }
    return plan;
}

export function buildStampingEntries({ unstamped, counterStart, reservationId, issuanceAt, canonicalizationVersion }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-stamp] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-stamp] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-stamp] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-stamp] issuanceAt required');
    if (typeof canonicalizationVersion !== 'string' || !canonicalizationVersion) {
        throw new Error('[SID-stamp] canonicalizationVersion required');
    }
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { compound, sidS } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(SMALL_MOLECULE_ENTITY_CLASS, counter);
        const anchor = smallMoleculeCanonicalAnchor(compound.inchi_key);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: SMALL_MOLECULE_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchor, canonicalizationVersion, reservationId, issuanceAt,
        });
        // crosswalk entry shape matches V1.0 §35 + Phase 1.1b validator
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: SMALL_MOLECULE_ENTITY_CLASS,
            canonicalization_version: canonicalizationVersion,
            canonical_identity_payload: anchor,
            counter_value: counter,
            reservation_id: reservationId,
            issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, compoundId: compound.id });
    }
    return entries;
}

export function applyStampsToCompounds(compounds, stampMap) {
    if (!Array.isArray(compounds)) throw new Error('[SID-stamp] compounds must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-stamp] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const compound of compounds) {
        if (!compound || typeof compound.id === 'undefined') continue;
        const stamp = stampMap.get(compound.id);
        if (!stamp) {
            // Paranoia branch: classifier said this compound should be in stampMap.
            // If we hit this, the classifier and the orchestrator's reservation
            // loop have drifted — non-recoverable, surface immediately.
            console.warn(`[SID-STAMP] paranoia miss: id=${compound.id} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        compound.sid_s = stamp.sid_s;
        compound.sid_c = stamp.sid_c;
    }
    return { compounds, skippedParanoiaCount };
}

export function buildStampingSummary({
    totalCompounds, alreadyStamped, newlyStamped, unstampable,
    reservationsIssued, skippedParanoiaCount, elapsedMs, ledgerKeys,
}) {
    return {
        total_compounds: totalCompounds,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable: unstampable,
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs,
        ledger_keys: ledgerKeys || [],
    };
}
