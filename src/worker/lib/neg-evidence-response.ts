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

function severityFromRollup(r: [number, number, number, number]): Record<SeverityKey, number> {
    return { critical: r[0] ?? 0, major: r[1] ?? 0, minor: r[2] ?? 0, unknown: r[3] ?? 0 };
}

function highestSeverity(by: Record<SeverityKey, number>): SeverityKey | 'none' {
    if (by.critical > 0) return 'critical';
    if (by.major > 0) return 'major';
    if (by.minor > 0) return 'minor';
    if (by.unknown > 0) return 'unknown';
    return 'none';
}

function recommendationFor(highest: SeverityKey | 'none'): string {
    if (highest === 'critical') return 'Material negative evidence present — agent should treat this compound as carrying critical risk and require explicit justification for any clinical-decision use case.';
    if (highest === 'major') return 'Substantive negative evidence — agent should surface findings prominently in any recommendation and weigh against alternatives.';
    if (highest === 'minor') return 'Minor negative signals only — agent may proceed with normal caution and disclose findings.';
    if (highest === 'unknown') return 'Negative signals exist but severity is unclassified — agent should fetch source records for human review.';
    return 'No negative evidence found in current snapshot. Absence of signal is not absence of risk — agent should still consult primary literature.';
}

function signalUrl(baseUrl: string, id: string): string {
    return `${baseUrl}/api/v1/entity/${encodeURIComponent(id)}`;
}

function shapeSignal(rec: NegEvidenceRecord, baseUrl: string) {
    return {
        id: rec.id,
        url: signalUrl(baseUrl, rec.id),
        evidence_type: rec.evidence_type,
        severity: rec.severity,
        reason_category: rec.failure?.reason_category,
        occurred_date: rec.occurred_date,
        observed_date: rec.observed_date,
        confidence: rec.confidence?.overall,
        subject: rec.subject,
        detail: rec.detail,
        provenance: rec.provenance,
    };
}

/**
 * Pre-computed FILTERED aggregates for an event_type-filtered request. When
 * present, these OVERRIDE the entry's unfiltered rollups so the response's
 * `negative_signals_count` / `signals_by_severity` / `signals_by_evidence_type`
 * describe the FILTERED set exactly (count == |matched-after-filter|, paginable
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
    const bySeverity = filtered
        ? filtered.bySeverity
        : (entry ? severityFromRollup(entry.severity_rollup) : { critical: 0, major: 0, minor: 0, unknown: 0 });
    const byType: Record<string, number> = filtered
        ? { ...filtered.byType }
        : (entry ? { ...entry.type_rollup } : {});
    const unknownTypes = Object.keys(byType).filter(t => !isKnownEvidenceType(t)).sort();
    const highest = highestSeverity(bySeverity);
    const returned = pageRecords.length;
    const hasMore = offset + returned < total;
    const pagination: Pagination = {
        offset, limit, returned, has_more: hasMore,
        next_offset: hasMore ? offset + returned : null,
    };
    const summary = total === 0
        ? 'No negative signals recorded for this compound in current snapshot.'
        : `${total} negative signal${total === 1 ? '' : 's'} across ${Object.keys(byType).length} evidence type${Object.keys(byType).length === 1 ? '' : 's'}; highest severity: ${highest}.`;
    return {
        compound: { id: compoundId, url: signalUrl(baseUrl, compoundId) },
        snapshot_date: snapshotDate,
        negative_signals_count: total,
        pagination,
        signals_by_severity: bySeverity,
        signals_by_evidence_type: byType,
        unknown_event_types: unknownTypes,
        signals: pageRecords.map(r => shapeSignal(r, baseUrl)),
        verdict: { summary, highest_severity: highest, agent_recommendation: recommendationFor(highest) },
    };
}

/**
 * Summary shape for the repurposing aggregator: manifest rollups + a few
 * examples from the first page. Never loads more than one page.
 */
export function shapeSummaryResponse(entry: NegManifestEntry | null, firstPage: NegEvidenceRecord[]) {
    const total = entry?.total ?? 0;
    const bySeverity = entry ? severityFromRollup(entry.severity_rollup) : { critical: 0, major: 0, minor: 0, unknown: 0 };
    return {
        signals_count: total,
        signals_by_severity: bySeverity,
        examples: firstPage.slice(0, 5).map(s => ({ id: s.id, evidence_type: s.evidence_type, severity: s.severity })),
    };
}

export type NegPagedResponse = ReturnType<typeof shapePagedResponse>;
export type NegSummary = ReturnType<typeof shapeSummaryResponse>;
