/**
 * SID Bioactivity Stamping — Phase 1.5 pure-function helpers per V1.0
 * §35 + §26 bioactivity canonical anchor (single source: ChEMBL).
 *
 * Single-canon-version variant (simpler than Phase 1.3 paper / 1.4 target
 * multi-canon + cross-pollination). PubChem BioAssay validation tool
 * exists but does not yet INGEST bioactivities; multi-canon migration
 * is post-Phase 1.5 work.
 *
 * Defect-12 hardened: anchor derivation validates BOTH provenance source
 * label AND source_id format. Scans provenance.sources[] (NEVER [0]
 * indexing — defect-3 carry); accepts only entries where source ===
 * 'chembl' AND source_id matches /^\d+$/ (ChEMBL activity IDs are
 * integer strings). Records with poisoned metadata (chembl label but
 * malformed id) get rejected to unstampable.
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';

export const BIOACTIVITY_ENTITY_CLASS = 'bioactivity';
export const BIOACTIVITY_CANON_VERSION_CHEMBL = 'bioactivity.chembl.v1.0';
export const UNSTAMPABLE_REASON_MISSING_CHEMBL_ID = 'missing_chembl_activity_id';
export const CHEMBL_ACTIVITY_ID_PATTERN = /^\d+$/;

/**
 * Defect-12 hardened derivation.
 * Scans provenance.sources[] (NOT [0] index). For each entry, validates
 * BOTH (a) source === 'chembl' label AND (b) source_id matches
 * CHEMBL_ACTIVITY_ID_PATTERN. First entry passing both checks wins
 * (deterministic first-wins under upstream array reorder).
 */
export function deriveBioactivityChemblAnchor(bioactivity) {
    if (!bioactivity || typeof bioactivity !== 'object') return null;
    const provenance = bioactivity.provenance;
    if (!provenance || !Array.isArray(provenance.sources)) return null;
    for (const src of provenance.sources) {
        if (!src || src.source !== 'chembl') continue;
        const sourceId = src.source_id;
        if (typeof sourceId !== 'string' || sourceId.length === 0) continue;
        if (!CHEMBL_ACTIVITY_ID_PATTERN.test(sourceId)) continue;
        return { canonVersion: BIOACTIVITY_CANON_VERSION_CHEMBL, payload: `chembl:${sourceId}` };
    }
    return null;
}

function anchorToSidS(anchor) {
    return generateSID_S(BIOACTIVITY_ENTITY_CLASS, anchor.payload, anchor.canonVersion);
}

export function classifyBioactivities(bioactivities, crosswalkIndex) {
    if (!Array.isArray(bioactivities)) throw new Error('[SID-bioactivity] bioactivities must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-bioactivity] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    for (const bioactivity of bioactivities) {
        const anchor = deriveBioactivityChemblAnchor(bioactivity);
        if (!anchor) {
            unstampable.push({ bioactivity, reason: UNSTAMPABLE_REASON_MISSING_CHEMBL_ID });
            continue;
        }
        const sidS = anchorToSidS(anchor);
        const hit = crosswalkIndex.bySidS.get(sidS);
        if (hit && hit.length > 0) {
            alreadyStamped.push({ bioactivity, sidS, sidC: hit[0].sid_c, anchor });
        } else {
            unstamped.push({ bioactivity, sidS, anchor });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function buildBioactivityStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-bioactivity] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-bioactivity] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-bioactivity] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-bioactivity] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { bioactivity, sidS, anchor } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(BIOACTIVITY_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: BIOACTIVITY_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchor.payload, canonicalizationVersion: anchor.canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: BIOACTIVITY_ENTITY_CLASS,
            canonicalization_version: anchor.canonVersion,
            canonical_identity_payload: anchor.payload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, bioactivityId: bioactivity.id, anchor });
    }
    return entries;
}

export function applyStampsToBioactivities(bioactivities, stampMap) {
    if (!Array.isArray(bioactivities)) throw new Error('[SID-bioactivity] bioactivities must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-bioactivity] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const bioactivity of bioactivities) {
        if (!bioactivity || typeof bioactivity.id === 'undefined') continue;
        const stamp = stampMap.get(bioactivity.id);
        if (!stamp) {
            console.warn(`[BIOACTIVITY-STAMP] paranoia miss: id=${bioactivity.id} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        bioactivity.sid_s = stamp.sid_s;
        bioactivity.sid_c = stamp.sid_c;
    }
    return { bioactivities, skippedParanoiaCount };
}

export function buildBioactivityStampingSummary({
    totalBioactivities, alreadyStamped, newlyStamped, unstampable,
    stampedByChembl, reservationsIssued, skippedParanoiaCount,
    elapsedMs, ledgerKeys, shardCount,
}) {
    return {
        total_bioactivities: totalBioactivities,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable,
        stamped_by_chembl: stampedByChembl,
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs,
        ledger_keys: ledgerKeys || [],
        shard_count: shardCount,
    };
}
