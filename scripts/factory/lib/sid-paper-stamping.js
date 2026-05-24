/**
 * SID Paper Stamping — Phase 1.3 pure-function helpers per V1.0 §35 +
 * §26 paper canonical anchor (DOI primary, OpenAlex fallback).
 *
 * First entity class with MULTIPLE canonicalization_versions:
 *   - paper.doi.v1.0       primary
 *   - paper.openalex.v1.0  fallback
 * SID-S derivation incorporates canonicalization_version in hash input,
 * so a paper has DIFFERENT SID-S under each anchor type. Defect-5 fix
 * (crosswalk-aware fallback lookup) maintains identity stability when
 * a paper acquires DOI after first being stamped under OpenAlex.
 * Defect-5-expanded fix (cross-pollination write-back) prevents O(N)
 * lookup degradation + cross-source double-stamping disaster.
 *
 * Carry-forward fixes: classifier never throws on data shape (defect-2);
 * field-shape detection on identifier itself (defect-3); opaque paper.id
 * Map key (defect-4).
 */

import { generateSID_S, generateSID_C } from './sid-generator.js';
import { buildLedgerEntry } from './sid-counter-ledger.js';

export const PAPER_ENTITY_CLASS = 'paper';
export const PAPER_CANON_VERSION_DOI = 'paper.doi.v1.0';
export const PAPER_CANON_VERSION_OPENALEX = 'paper.openalex.v1.0';
export const UNSTAMPABLE_REASON_MISSING_PAPER_ID = 'missing_paper_identifier';

export const DOI_PATTERN = /^10\.\d{4,}\/\S+$/;
export const OPENALEX_ID_PATTERN = /^W\d+$/;

/** Defensive DOI sanitization: strip whitespace + scraper trailing punctuation, lowercase. */
export function sanitizeDoi(rawDoi) {
    if (typeof rawDoi !== 'string') return null;
    const trimmed = rawDoi.trim();
    if (!trimmed) return null;
    const stripped = trimmed.replace(/[\.,;:)\]\s]+$/, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    return stripped.toLowerCase();
}

export function deriveDoiAnchor(paper) {
    if (!paper || typeof paper !== 'object') return null;
    const doi = sanitizeDoi(paper.doi);
    if (!doi || !DOI_PATTERN.test(doi)) return null;
    return { canonVersion: PAPER_CANON_VERSION_DOI, payload: `doi:${doi}` };
}

export function deriveOpenAlexAnchor(paper) {
    if (!paper || typeof paper !== 'object') return null;
    const oa = paper.openalex_id;
    if (typeof oa !== 'string' || !OPENALEX_ID_PATTERN.test(oa)) return null;
    return { canonVersion: PAPER_CANON_VERSION_OPENALEX, payload: `openalex:${oa}` };
}

function anchorToSidS(anchor) {
    return generateSID_S(PAPER_ENTITY_CLASS, anchor.payload, anchor.canonVersion);
}

export function derivePaperSidSCandidates(paper) {
    const doi = deriveDoiAnchor(paper);
    const openalex = deriveOpenAlexAnchor(paper);
    let primary = null;
    let fallback = null;
    if (doi) {
        primary = { sidS: anchorToSidS(doi), canonVersion: doi.canonVersion, payload: doi.payload };
        if (openalex) {
            fallback = { sidS: anchorToSidS(openalex), canonVersion: openalex.canonVersion, payload: openalex.payload };
        }
    } else if (openalex) {
        primary = { sidS: anchorToSidS(openalex), canonVersion: openalex.canonVersion, payload: openalex.payload };
    }
    return { primary, fallback };
}

export function classifyPapers(papers, crosswalkIndex) {
    if (!Array.isArray(papers)) throw new Error('[SID-paper] papers must be array');
    if (!crosswalkIndex || !crosswalkIndex.bySidS) {
        throw new Error('[SID-paper] crosswalkIndex with bySidS map required');
    }
    const alreadyStamped = [];
    const unstamped = [];
    const unstampable = [];
    const crossPollination = [];
    for (const paper of papers) {
        const { primary, fallback } = derivePaperSidSCandidates(paper);
        if (!primary) {
            unstampable.push({ paper, reason: UNSTAMPABLE_REASON_MISSING_PAPER_ID });
            continue;
        }
        const primaryHit = crosswalkIndex.bySidS.get(primary.sidS);
        if (primaryHit && primaryHit.length > 0) {
            alreadyStamped.push({ paper, sidS: primary.sidS, sidC: primaryHit[0].sid_c, anchor: primary });
            continue;
        }
        if (fallback) {
            const fallbackHit = crosswalkIndex.bySidS.get(fallback.sidS);
            if (fallbackHit && fallbackHit.length > 0) {
                const existingEntry = fallbackHit[0];
                alreadyStamped.push({ paper, sidS: fallback.sidS, sidC: existingEntry.sid_c, anchor: fallback });
                crossPollination.push({
                    paper, primarySidS: primary.sidS, fallbackSidS: fallback.sidS,
                    sidC: existingEntry.sid_c, counterValue: existingEntry.counter_value,
                    anchor: primary,
                });
                continue;
            }
        }
        unstamped.push({ paper, sidS: primary.sidS, anchor: primary });
    }
    return { alreadyStamped, unstamped, unstampable, crossPollination };
}

export function buildPaperStampingEntries({ unstamped, counterStart, reservationId, issuanceAt }) {
    if (!Array.isArray(unstamped)) throw new Error('[SID-paper] unstamped must be array');
    if (typeof counterStart !== 'number' || !Number.isInteger(counterStart) || counterStart < 1) {
        throw new Error('[SID-paper] counterStart must be positive integer');
    }
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-paper] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-paper] issuanceAt required');
    const entries = [];
    for (let i = 0; i < unstamped.length; i++) {
        const { paper, sidS, anchor } = unstamped[i];
        const counter = counterStart + i;
        const sidC = generateSID_C(PAPER_ENTITY_CLASS, counter);
        const ledgerEntry = buildLedgerEntry({
            counterValue: counter, entityClass: PAPER_ENTITY_CLASS, sidS, sidC,
            canonicalIdentityPayload: anchor.payload, canonicalizationVersion: anchor.canonVersion,
            reservationId, issuanceAt,
        });
        const crosswalkEntry = {
            sid_s: sidS, sid_c: sidC,
            entity_class: PAPER_ENTITY_CLASS,
            canonicalization_version: anchor.canonVersion,
            canonical_identity_payload: anchor.payload,
            counter_value: counter, reservation_id: reservationId, issuance_at: issuanceAt,
        };
        entries.push({ sidS, sidC, ledgerEntry, crosswalkEntry, paperId: paper.id, anchor });
    }
    return entries;
}

/**
 * Build crosswalk entries for cross-pollination bindings (defect-5-expanded fix).
 * For each cross-pollination target, binds the freshly-derived primary sid_s
 * to the EXISTING sid_c (no new counter consumed). Does NOT produce ledger
 * entries — the counter was already issued in a prior cycle's ledger.
 */
export function buildCrossPollinationEntries({ crossPollination, reservationId, issuanceAt }) {
    if (!Array.isArray(crossPollination)) throw new Error('[SID-paper] crossPollination must be array');
    if (typeof reservationId !== 'string' || !reservationId) throw new Error('[SID-paper] reservationId required');
    if (typeof issuanceAt !== 'string' || !issuanceAt) throw new Error('[SID-paper] issuanceAt required');
    return crossPollination.map(cp => ({
        sid_s: cp.primarySidS, sid_c: cp.sidC,
        entity_class: PAPER_ENTITY_CLASS,
        canonicalization_version: cp.anchor.canonVersion,
        canonical_identity_payload: cp.anchor.payload,
        counter_value: cp.counterValue,
        reservation_id: reservationId, issuance_at: issuanceAt,
    }));
}

export function applyStampsToPapers(papers, stampMap) {
    if (!Array.isArray(papers)) throw new Error('[SID-paper] papers must be array');
    if (!(stampMap instanceof Map)) throw new Error('[SID-paper] stampMap must be Map');
    let skippedParanoiaCount = 0;
    for (const paper of papers) {
        if (!paper || typeof paper.id === 'undefined') continue;
        const stamp = stampMap.get(paper.id);
        if (!stamp) {
            console.warn(`[PAPER-STAMP] paranoia miss: id=${paper.id} not in stampMap`);
            skippedParanoiaCount++;
            continue;
        }
        paper.sid_s = stamp.sid_s;
        paper.sid_c = stamp.sid_c;
    }
    return { papers, skippedParanoiaCount };
}

export function buildPaperStampingSummary({
    totalPapers, alreadyStamped, newlyStamped, unstampable, crossPollinated,
    stampedByDoi, stampedByOpenalex,
    reservationsIssued, skippedParanoiaCount, elapsedMs, ledgerKeys,
}) {
    return {
        total_papers: totalPapers,
        already_stamped: alreadyStamped,
        newly_stamped: newlyStamped,
        unstampable, cross_pollinated: crossPollinated,
        stamped_by_doi: stampedByDoi, stamped_by_openalex: stampedByOpenalex,
        reservations_issued: reservationsIssued,
        skipped_paranoia_count: skippedParanoiaCount,
        elapsed_ms: elapsedMs, ledger_keys: ledgerKeys || [],
    };
}
