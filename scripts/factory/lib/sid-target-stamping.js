/**
 * SID Target Stamping — Phase 1.4 pure-function helpers per V1.0 §35 +
 * §26 target canonical anchor (UniProt primary, Ensembl fallback).
 *
 * Second multi-canonicalization-version entity class after Phase 1.3
 * paper (DOI/OpenAlex). Validates pattern reusability beyond paper case.
 *
 * Per V1.0 §26 amendment (PR-SID-1.4 locks this):
 *   target.uniprot.v1.0   primary anchor: uniprot:<accession>
 *   target.ensembl.v1.0   fallback anchor: ensembl:<gene_id>
 *
 * Defect-1..10 carry-forward:
 *   1. Crosswalk RMW lock — via shared casExecuteCrosswalkUpdate
 *   2. Classifier never throws on data shape — push to unstampable
 *   3. Field-shape detection on identifier itself, not metadata
 *   4. Opaque target.id Map key — no string reconstruction
 *   5. Crosswalk-aware fallback lookup
 *   6. Cross-pollination crosswalk write-back
 *   7. Callback-based atomic RMW API (shared lib defect-6 fix)
 *   8. UniProt isoform truncation roll-up — sanitizeUniprot already
 *      applied at target-linker boundary; here defended again as
 *      Layer 3 safety
 *   9. Non-protein-coding biotype hard filter — already enforced at
 *      OT SQL Layer 1 + transformer Layer 2; here trust upstream
 *  10. Target dedup correctness across OT + bioactivity sources —
 *      already handled at target-linker; here single target.id key
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';
import { sanitizeUniprot } from './open-targets-target-sql.js';

export const TARGET_ENTITY_CLASS = 'target';
export const TARGET_CANON_VERSION_UNIPROT = 'target.uniprot.v1.0';
export const TARGET_CANON_VERSION_ENSEMBL = 'target.ensembl.v1.0';
export const UNSTAMPABLE_REASON_MISSING_TARGET_ID = 'missing_target_identifier';

// Official UniProt accession regex: 6-char ([OPQ] start) OR 10-char ([A-NR-Z] start).
// Per https://www.uniprot.org/help/accession_numbers — covers all canonical
// accessions including isoforms (post-sanitizeUniprot truncation strips -N).
export const UNIPROT_PATTERN = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;
export const ENSEMBL_PATTERN = /^ENSG\d{11}$/;

export function deriveUniprotAnchor(target) {
    if (!target || typeof target !== 'object') return null;
    const sanitized = sanitizeUniprot(target.uniprot_accession);
    if (!sanitized || !UNIPROT_PATTERN.test(sanitized)) return null;
    return { canonVersion: TARGET_CANON_VERSION_UNIPROT, payload: `uniprot:${sanitized}` };
}

export function deriveEnsemblAnchor(target) {
    if (!target || typeof target !== 'object') return null;
    const ens = target.ensembl_gene_id;
    if (typeof ens !== 'string' || !ENSEMBL_PATTERN.test(ens)) return null;
    return { canonVersion: TARGET_CANON_VERSION_ENSEMBL, payload: `ensembl:${ens}` };
}

function anchorToSidS(anchor) {
    return generateSID_S(TARGET_ENTITY_CLASS, anchor.payload, anchor.canonVersion);
}

export function deriveTargetSidSCandidates(target) {
    const uniprot = deriveUniprotAnchor(target);
    const ensembl = deriveEnsemblAnchor(target);
    let primary = null;
    let fallback = null;
    if (uniprot) {
        primary = { sidS: anchorToSidS(uniprot), canonVersion: uniprot.canonVersion, payload: uniprot.payload };
        if (ensembl) {
            fallback = { sidS: anchorToSidS(ensembl), canonVersion: ensembl.canonVersion, payload: ensembl.payload };
        }
    } else if (ensembl) {
        primary = { sidS: anchorToSidS(ensembl), canonVersion: ensembl.canonVersion, payload: ensembl.payload };
    }
    return { primary, fallback };
}

export function classifyTargets(targets, crosswalkIndex) {
    if (!Array.isArray(targets)) throw new Error('[SID-target] targets must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-target] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    const crossPollination = [];
    for (const target of targets) {
        const { primary, fallback } = deriveTargetSidSCandidates(target);
        if (!primary) {
            unstampable.push({ target, reason: UNSTAMPABLE_REASON_MISSING_TARGET_ID });
            continue;
        }
        const primaryHit = crosswalkIndex.bySidS.get(primary.sidS);
        if (primaryHit && primaryHit.length > 0) {
            alreadyStamped.push({ target, sidS: primary.sidS, sidC: primaryHit[0].sid_c, anchor: primary });
            continue;
        }
        if (fallback) {
            const fallbackHit = crosswalkIndex.bySidS.get(fallback.sidS);
            if (fallbackHit && fallbackHit.length > 0) {
                const existingEntry = fallbackHit[0];
                alreadyStamped.push({ target, sidS: fallback.sidS, sidC: existingEntry.sid_c, anchor: fallback });
                crossPollination.push({
                    target, primarySidS: primary.sidS, fallbackSidS: fallback.sidS,
                    sidC: existingEntry.sid_c, counterValue: existingEntry.counter_value,
                    anchor: primary,
                });
                continue;
            }
        }
        unstamped.push({ target, sidS: primary.sidS, anchor: primary });
    }
    return { alreadyStamped, unstamped, unstampable, crossPollination };
}

export function buildTargetStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-target] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-target] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-target] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-target] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { target, sidS, anchor } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(TARGET_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: TARGET_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchor.payload, canonicalizationVersion: anchor.canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: TARGET_ENTITY_CLASS,
            canonicalization_version: anchor.canonVersion,
            canonical_identity_payload: anchor.payload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, targetId: target.id, anchor });
    }
    return entries;
}

export function buildTargetCrossPollinationEntries({ crossPollination, reservationId, issuanceAt }) {
    if (!Array.isArray(crossPollination)) throw new Error('[SID-target] crossPollination must be array');
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-target] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-target] issuanceAt required');
    return crossPollination.map(cp => ({
        sid_s: cp.primarySidS, sid_c: cp.sidC,
        entity_class: TARGET_ENTITY_CLASS,
        canonicalization_version: cp.anchor.canonVersion,
        canonical_identity_payload: cp.anchor.payload,
        counter_value: cp.counterValue,
        reservation_id: reservationId, issuance_at: issuanceAt,
    }));
}

export function applyStampsToTargets(targets, stampMap) {
    if (!Array.isArray(targets)) throw new Error('[SID-target] targets must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-target] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const target of targets) {
        if (!target || typeof target.id === 'undefined') continue;
        const stamp = stampMap.get(target.id);
        if (!stamp) {
            console.warn(`[TARGET-STAMP] paranoia miss: id=${target.id} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        target.sid_s = stamp.sid_s;
        target.sid_c = stamp.sid_c;
    }
    return { targets, skippedParanoiaCount };
}

export function buildTargetStampingSummary({
    totalTargets, alreadyStamped, newlyStamped, unstampable, crossPollinated,
    stampedByUniprot, stampedByEnsembl,
    reservationsIssued, skippedParanoiaCount, elapsedMs, ledgerKeys,
}) {
    return {
        total_targets: totalTargets,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable, cross_pollinated: crossPollinated,
        stamped_by_uniprot: stampedByUniprot, stamped_by_ensembl: stampedByEnsembl,
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs, ledger_keys: ledgerKeys || [],
    };
}
