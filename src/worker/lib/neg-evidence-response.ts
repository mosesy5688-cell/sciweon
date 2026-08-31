/**
 * NegEvidence response shaping — pure functions extracted from
 * neg-evidence-loader.ts so the loader stays under the CES 250-line cap.
 *
 * Two shapes:
 *   - shapePagedResponse: the sharded paginated signals response. The STORED
 *     neg-evidence is complete; this bounds ONLY the per-request payload. The
 *     bound is paginable + LOUD: a pagination block carries the true `total`
 *     (from the manifest entry) + `has_more` + `next_offset`, so a caller can
 *     always page to completeness.
 *   - shapeSummaryResponse: the aggregator's summary (manifest rollups + a few
 *     examples from the first page).
 */

import { type EvidenceType, isKnownEvidenceType } from './event-type-taxonomy';
import { TYPE_FAERS_ADR_SIGNAL } from '../../lib/schemas/neg-evidence-types.js';
import type { NegManifestEntry } from './neg-manifest-loader';

const SEVERITY_KEYS = ['critical', 'major', 'minor', 'unknown'] as const;
type SeverityKey = typeof SEVERITY_KEYS[number];

export interface NegEvidenceRecord {
    id: string;
    evidence_type: EvidenceType | string;
    subject?: Record<string, string | undefined>;
    failure?: { reason_category?: string };
    detail?: Record<string, unknown>;
    occurred_date?: string;
    observed_date?: string;
    severity: SeverityKey;
    confidence?: { overall?: number };
    provenance?: Record<string, unknown>;
}

export interface Pagination {
    offset: number;
    limit: number;
    returned: number;
    has_more: boolean;
    next_offset: number | null;
}

/*
 * `severityFromRollup` REMOVED with the public severity surface. `SeverityKey`
 * is retained because the stored record and the loader's internal filtered
 * aggregate still carry the field -- it simply never reaches a response.
 */

/**
 * Evidence-use boundary carried on every negative-evidence response.
 *
 * Sciweon reports observed records with their provenance. It does NOT assess
 * causality, risk or clinical significance, and emits no clinical, diagnostic,
 * dosing or regulatory recommendation. Consumers -- including autonomous
 * agents -- perform their own synthesis from `signals[]`.
 *
 * WHY `severity` IS NOT PUBLISHED.
 * The stored `severity` is NOT a source classification. Sciweon assigns it
 * itself: `scripts/factory/lib/neg-builders-fda.js` maps a raw FAERS report
 * count onto a risk word (>= 10000 -> critical, >= 1000 -> major,
 * >= 100 -> minor), and hardcodes `critical` for black-box and withdrawal
 * records. A spontaneous-report count has no exposure denominator, so a
 * threshold over it cannot carry risk meaning. Publishing the grade would
 * republish the same unsupported inference the removed verdict made, one
 * level down. The grade is therefore withheld from every public surface; the
 * raw `report_count` that produced it is published instead, so a consumer can
 * see the evidence and draw its own conclusion.
 *
 * Spontaneous adverse-event reporting systems (FDA FAERS, renamed AEMS) carry
 * a further structural limit: reports are unverified, may be duplicated, and
 * have NO exposure denominator. Their counts cannot establish causation and
 * cannot yield incidence, rate or per-patient risk. Absence of reports is not
 * evidence of absence of risk.
 */
const SPONTANEOUS_REPORT_TYPES: readonly string[] = [TYPE_FAERS_ADR_SIGNAL];

const BOUNDARY_STATEMENT =
    'Research use only. Sciweon reports observed records with their provenance. '
    + 'It does not assess causality, risk or clinical significance and makes no clinical, '
    + 'diagnostic, dosing or regulatory recommendation. No severity or risk grading is '
    + 'published: raw source counts are returned instead so the consumer can judge.';

const SPONTANEOUS_REPORT_CAVEAT =
    'Counts derived from spontaneous adverse-event reporting (FDA FAERS/AEMS) are report '
    + 'counts only. Reports are unverified, may be duplicated, and have no exposure '
    + 'denominator: they cannot establish causation and cannot be used to derive incidence, '
    + 'rate or per-patient risk. Absence of reports is not evidence of absence of risk.';

export interface EvidenceUseBoundary {
    research_use_only: true;
    clinical_decision_support: false;
    causality_assessed: false;
    incidence_or_rate_derivable: false;
    statement: string;
    spontaneous_report_types_present: string[];
    spontaneous_report_caveat: string;
}

/**
 * The caveat is UNCONDITIONAL: both the paged negative-evidence response and
 * the repurposing aggregation can carry spontaneous-report-derived counts, and
 * a consumer must not have to infer the limit from whether a type happens to
 * appear on the current page. `spontaneous_report_types_present` reports what
 * is actually present in the aggregate; the caveat states the boundary either
 * way. Pass `byType` when the caller can enumerate types; omit it otherwise.
 */
export function evidenceUseBoundary(byType?: Record<string, number>): EvidenceUseBoundary {
    const present = byType
        ? SPONTANEOUS_REPORT_TYPES.filter(t => (byType[t] ?? 0) > 0)
        : [];
    return {
        research_use_only: true,
        clinical_decision_support: false,
        causality_assessed: false,
        incidence_or_rate_derivable: false,
        statement: BOUNDARY_STATEMENT,
        spontaneous_report_types_present: present,
        spontaneous_report_caveat: SPONTANEOUS_REPORT_CAVEAT,
    };
}

/**
 * Canonical compound URL. This points at a route that EXISTS
 * (`/api/v1/compound/:id`, registered in `src/worker.ts`).
 *
 * The previous `/api/v1/entity/<id>` self-link was minted on every signal and
 * on the compound, and NO such route is registered -- every one of those links
 * 404s. Signals no longer carry a `url` at all rather than advertise a
 * dereference Sciweon cannot honour; `id` remains, and is stable.
 */
function compoundUrl(baseUrl: string, compoundId: string): string {
    return `${baseUrl}/api/v1/compound/${encodeURIComponent(compoundId)}`;
}

function shapeSignal(rec: NegEvidenceRecord) {
    return {
        id: rec.id,
        evidence_type: rec.evidence_type,
        reason_category: rec.failure?.reason_category,
        occurred_date: rec.occurred_date,
        observed_date: rec.observed_date,
        confidence: rec.confidence?.overall,
        subject: rec.subject,
        // `detail` carries the RAW source count (e.g. `report_count`) that the
        // withheld severity grade was derived from. Rights-restricted members
        // (e.g. `meddra_pt`) are removed downstream by source-rights-filter.
        detail: rec.detail,
        provenance: rec.provenance,
    };
}

/**
 * Pre-computed FILTERED aggregates for an event_type-filtered request. When
 * present, these OVERRIDE the entry's unfiltered rollups so the response's
 * `negative_signals_count` / `signals_by_evidence_type` (and the INTERNAL
 * `bySeverity`, which is never emitted) describe the FILTERED set exactly (count == |matched-after-filter|, paginable
 * to completion). The loader computes these O(1) from the manifest's
 * `type_rollup` + `sev_by_type` cross-tab (no full-corpus scan).
 */
export interface NegFilteredAgg {
    total: number;
    bySeverity: Record<SeverityKey, number>;
    byType: Record<string, number>;
}

/**
 * Build the paginated signals response. `pageRecords` are the records covering
 * [offset, offset+limit) already sliced by the loader. `entry` carries the
 * authoritative `total` + rollups (so aggregates reflect the WHOLE compound,
 * not just this page). When `entry` is null the compound has zero stored
 * negative evidence (authoritative empty). When `filtered` is supplied the
 * count/aggregates describe the event_type-FILTERED set instead of the entry's
 * unfiltered rollups (and `total` becomes the filtered total for pagination).
 */
export function shapePagedResponse(
    compoundId: string,
    entry: NegManifestEntry | null,
    pageRecords: NegEvidenceRecord[],
    offset: number,
    limit: number,
    snapshotDate: string,
    baseUrl: string,
    filtered?: NegFilteredAgg | null,
) {
    const total = filtered ? filtered.total : (entry?.total ?? 0);
    const byType: Record<string, number> = filtered
        ? { ...filtered.byType }
        : (entry ? { ...entry.type_rollup } : {});
    const unknownTypes = Object.keys(byType).filter(t => !isKnownEvidenceType(t)).sort();
    const returned = pageRecords.length;
    const hasMore = offset + returned < total;
    const pagination: Pagination = {
        offset, limit, returned, has_more: hasMore,
        next_offset: hasMore ? offset + returned : null,
    };
    // NOTE: the severity rollup is deliberately NOT emitted. `entry` still
    // carries `severity_rollup` for internal use; it stops at this boundary.
    return {
        compound: { id: compoundId, url: compoundUrl(baseUrl, compoundId) },
        snapshot_date: snapshotDate,
        negative_signals_count: total,
        pagination,
        signals_by_evidence_type: byType,
        unknown_event_types: unknownTypes,
        signals: pageRecords.map(r => shapeSignal(r)),
        evidence_use_boundary: evidenceUseBoundary(byType),
    };
}

/**
 * Summary shape for the repurposing aggregator: manifest rollups + a few
 * examples from the first page. Never loads more than one page.
 */
export function shapeSummaryResponse(entry: NegManifestEntry | null, firstPage: NegEvidenceRecord[]) {
    const total = entry?.total ?? 0;
    // No severity rollup and no per-example severity: the repurposing surface
    // is public and must not carry the grade either.
    return {
        signals_count: total,
        examples: firstPage.slice(0, 5).map(s => ({ id: s.id, evidence_type: s.evidence_type })),
    };
}

export type NegPagedResponse = ReturnType<typeof shapePagedResponse>;
export type NegSummary = ReturnType<typeof shapeSummaryResponse>;
