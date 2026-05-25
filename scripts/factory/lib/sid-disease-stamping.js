/**
 * SID Disease Stamping — Phase 1.6b pure-function helpers per V1.0 §35 + §26
 * disease entity-class amendment (architect-locked 2026-05-25).
 *
 * Per-namespace multi-canonicalization-version protocol (Plan A1) — 6 canon
 * tracks all funnel through one `disease` entity_class counter bucket:
 *   disease.efo.v1.0 / disease.mondo.v1.0 / disease.oba.v1.0 /
 *   disease.hp.v1.0 / disease.orphanet.v1.0 / disease.unclassified_ontology.v1.0
 *
 * Architectural simplification vs Phase 1.4 target stamper: NO cross-pollination
 * logic. Phase 1.4 needed UniProt-OR-Ensembl ambiguity resolution because the
 * same target could appear under either anchor depending on source. Disease is
 * deterministically single-canon per record — pre.1b disease-linker pre-parses
 * raw_disease_id into exactly one (namespace, anchor_payload, canonicalization_version)
 * triple. Stamper consumes those fields directly; no fallback chain.
 *
 * Hard-fail invariant per [[cross_cycle_silent_data_loss]]: missing
 * anchor_payload / canonicalization_version / namespace on input pushes to
 * unstampable; orchestrator HALTS (linker upstream should have populated all
 * three fields on every emitted record).
 *
 * Frozen reference SID-S pins (execution-gate verified 2026-05-25 + production
 * R2 probe validated end-to-end via pre.1b open-derivability check):
 *   EFO_0000094              -> bbe589ace6048150231646c7dfdc510b
 *   MONDO_0000005            -> ca10368a6f87a07e0bcd9c9c0ad1cd4b
 *   OBA_0000015              -> 97e43da8376555aaa21763667619097a
 *   HP_0000002               -> 56b568ff785d279acde583e08d0dfa56
 *   Orphanet_100             -> 88f2c9c94c3c04de40aa1800aba9db43
 *   DOID_0050890 (tail-fuse) -> 73c43a1559327b12fb7063d719104da0
 *
 * Semantic Weight Isolation (V1.0 §49): SID-S derived from anchor_payload via
 * the established sha256("sciweon:<entity>:<canon>:<payload>")[:32] formula —
 * tail-fuse anchor_payload preserves FULL raw id (e.g. unclassified_ontology:
 * DOID_0050890) to prevent collision across long-tail ontologies sharing the
 * same numeric suffix.
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';
import {
    CANON_VERSIONS, PRIMARY_NAMESPACE_MAP, TAIL_FUSE_NAMESPACE,
} from '../../../src/lib/schemas/disease.js';

export const DISEASE_ENTITY_CLASS = 'disease';
export const UNSTAMPABLE_REASON_MISSING_ANCHOR = 'missing_anchor_metadata';
export { CANON_VERSIONS, PRIMARY_NAMESPACE_MAP, TAIL_FUSE_NAMESPACE };

export function classifyDiseases(diseases, crosswalkIndex) {
    if (!Array.isArray(diseases)) throw new Error('[SID-disease] diseases must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-disease] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    for (const disease of diseases) {
        const ap = disease?.anchor_payload;
        const cv = disease?.canonicalization_version;
        const ns = disease?.namespace;
        if (typeof ap !== 'string' || ap.length === 0
            || typeof cv !== 'string' || cv.length === 0
            || typeof ns !== 'string' || ns.length === 0) {
            unstampable.push({ disease, reason: UNSTAMPABLE_REASON_MISSING_ANCHOR });
            continue;
        }
        const sidS = generateSID_S(DISEASE_ENTITY_CLASS, ap, cv);
        const hit = crosswalkIndex.bySidS.get(sidS);
        if (hit && hit.length > 0) {
            alreadyStamped.push({ disease, sidS, sidC: hit[0].sid_c, anchorPayload: ap, canonVersion: cv });
        } else {
            unstamped.push({ disease, sidS, anchorPayload: ap, canonVersion: cv });
        }
    }
    return { alreadyStamped, unstamped, unstampable };
}

export function buildDiseaseStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-disease] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-disease] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-disease] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-disease] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { disease, sidS, anchorPayload, canonVersion } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(DISEASE_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: DISEASE_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchorPayload, canonicalizationVersion: canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: DISEASE_ENTITY_CLASS,
            canonicalization_version: canonVersion,
            canonical_identity_payload: anchorPayload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, diseaseId: disease.id });
    }
    return entries;
}

export function applyStampsToDiseases(diseases, stampMap) {
    if (!Array.isArray(diseases)) throw new Error('[SID-disease] diseases must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-disease] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const disease of diseases) {
        if (!disease || typeof disease.id === 'undefined') continue;
        const stamp = stampMap.get(disease.id);
        if (!stamp) {
            console.warn(`[DISEASE-STAMP] paranoia miss: id=${disease.id} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        disease.sid_s = stamp.sid_s;
        disease.sid_c = stamp.sid_c;
    }
    return { diseases, skippedParanoiaCount };
}

export function buildPerCanonVersionCounts(diseases) {
    const counts = {};
    for (const ns of Object.values(PRIMARY_NAMESPACE_MAP)) counts[ns] = 0;
    counts[TAIL_FUSE_NAMESPACE] = 0;
    for (const d of diseases) {
        if (d && typeof d.namespace === 'string' && Object.prototype.hasOwnProperty.call(counts, d.namespace)) {
            counts[d.namespace]++;
        }
    }
    return counts;
}

export function buildDiseaseStampingSummary({
    totalDiseases, alreadyStamped, newlyStamped, unstampable,
    perCanonVersionCounts, reservationsIssued, skippedParanoiaCount,
    elapsedMs, ledgerKeys, shardCount,
}) {
    return {
        total_diseases: totalDiseases,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable,
        per_canon_version_counts: perCanonVersionCounts || {},
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs,
        ledger_keys: ledgerKeys || [],
        shard_count: shardCount,
    };
}
