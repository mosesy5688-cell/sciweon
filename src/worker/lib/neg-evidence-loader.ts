/**
 * NegEvidence loader — reads the latest snapshot's neg-evidence.jsonl(.gz)
 * from R2, filters records by compound_id, and shapes the API response.
 *
 * Snapshot location (per scripts/factory/snapshot-uploader.js):
 *   snapshots/latest.json            → { latest_snapshot_date: "YYYY-MM-DD" }
 *   snapshots/<date>/neg-evidence.jsonl.gz
 *
 * Caching strategy: snapshots are immutable once published. fetchR2Object
 * caches by (key, etag) per isolate. The first call per day pays the
 * ~1MB gzipped download + decompress; every subsequent call inside the
 * same isolate hits the cache instantly.
 *
 * Response shape: per SCIWEON_DATA_ARCHITECTURE §3.0 spec example.
 * Verdict is computed (highest severity, total count) — Agent may ignore
 * it and read raw signals[] directly.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';
import { type EvidenceType, isKnownEvidenceType } from './event-type-taxonomy';

const LATEST_POINTER_KEY = 'snapshots/latest.json';

interface SnapshotPointer {
    latest_snapshot_date: string;
}

interface NegEvidenceRecord {
    id: string;
    // V0.5.8 Phase 1: evidence_type is the canonical typed taxonomy (7 values).
    // Allow `string` to cover legacy / forward-compat records — unknown values
    // are tracked separately in response.unknown_event_types for operator visibility.
    evidence_type: EvidenceType | string;
    subject?: {
        compound_id?: string;
        target_id?: string;
        paper_id?: string;
        trial_id?: string;
        bioactivity_id?: string;
    };
    failure?: {
        reason_category?: string;
        extraction_method?: string;
        extraction_confidence?: number;
    };
    detail?: Record<string, unknown>;
    occurred_date?: string;
    observed_date?: string;
    severity: 'critical' | 'major' | 'minor' | 'unknown';
    confidence?: { overall?: number };
    provenance?: {
        primary_source?: string;
        source_url?: string;
        source_id?: string;
    };
}

async function readLatestPointer(bucket: R2Bucket): Promise<string> {
    const text = await fetchR2JsonText(bucket, LATEST_POINTER_KEY);
    const parsed = JSON.parse(text) as SnapshotPointer;
    if (!parsed.latest_snapshot_date) {
        throw new Error('snapshots/latest.json missing latest_snapshot_date');
    }
    return parsed.latest_snapshot_date;
}

async function loadNegEvidenceJsonl(bucket: R2Bucket, date: string): Promise<NegEvidenceRecord[]> {
    const key = `snapshots/${date}/neg-evidence.jsonl.gz`;
    const text = await fetchR2GunzippedText(bucket, key);
    const records: NegEvidenceRecord[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            records.push(JSON.parse(line) as NegEvidenceRecord);
        } catch {
            // Single malformed line should not blow up the entire response.
            // Validation gate at producer (REJECT mode since PR #14) means
            // this should never happen in fresh data; defensive only.
        }
    }
    return records;
}

const SEVERITY_RANK = { critical: 4, major: 3, minor: 2, unknown: 1 } as const;

export interface NegEvidenceResponse {
    compound: { id: string; url: string };
    snapshot_date: string;
    negative_signals_count: number;
    signals_by_severity: Record<'critical' | 'major' | 'minor' | 'unknown', number>;
    signals_by_evidence_type: Record<string, number>;
    // V0.5.8 Phase 1: evidence_type values present in this response that are
    // NOT in EVIDENCE_TYPES. Empty array when all clean. Surfaces producer-side
    // typos / new types waiting to be added to the canonical taxonomy.
    unknown_event_types: string[];
    signals: Array<{
        id: string;
        url: string;
        evidence_type: string;
        severity: string;
        reason_category?: string;
        occurred_date?: string;
        observed_date?: string;
        confidence?: number;
        subject: NegEvidenceRecord['subject'];
        detail?: Record<string, unknown>;
        provenance?: NegEvidenceRecord['provenance'];
    }>;
    verdict: {
        summary: string;
        highest_severity: 'critical' | 'major' | 'minor' | 'unknown' | 'none';
        agent_recommendation: string;
    };
}

function buildResponse(compoundId: string, records: NegEvidenceRecord[], snapshotDate: string, baseUrl: string): NegEvidenceResponse {
    const compoundUrl = `${baseUrl}/api/v1/entity/${encodeURIComponent(compoundId)}`;
    const bySeverity = { critical: 0, major: 0, minor: 0, unknown: 0 };
    const byType: Record<string, number> = {};
    const unknownTypes = new Set<string>();
    const signals: NegEvidenceResponse['signals'] = [];
    let highestRank = 0;
    let highest: NegEvidenceResponse['verdict']['highest_severity'] = 'none';

    for (const rec of records) {
        const sev = (rec.severity ?? 'unknown') as keyof typeof SEVERITY_RANK;
        bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
        byType[rec.evidence_type] = (byType[rec.evidence_type] ?? 0) + 1;
        if (!isKnownEvidenceType(rec.evidence_type)) {
            unknownTypes.add(rec.evidence_type);
        }
        const rank = SEVERITY_RANK[sev] ?? 1;
        if (rank > highestRank) {
            highestRank = rank;
            highest = sev;
        }
        signals.push({
            id: rec.id,
            url: `${baseUrl}/api/v1/entity/${encodeURIComponent(rec.id)}`,
            evidence_type: rec.evidence_type,
            severity: sev,
            reason_category: rec.failure?.reason_category,
            occurred_date: rec.occurred_date,
            observed_date: rec.observed_date,
            confidence: rec.confidence?.overall,
            subject: rec.subject,
            detail: rec.detail,
            provenance: rec.provenance,
        });
    }

    const recommendation = recommendationFor(highest, bySeverity);
    const summary = signals.length === 0
        ? 'No negative signals recorded for this compound in current snapshot.'
        : `${signals.length} negative signal${signals.length === 1 ? '' : 's'} across ${Object.keys(byType).length} evidence type${Object.keys(byType).length === 1 ? '' : 's'}; highest severity: ${highest}.`;

    return {
        compound: { id: compoundId, url: compoundUrl },
        snapshot_date: snapshotDate,
        negative_signals_count: signals.length,
        signals_by_severity: bySeverity,
        signals_by_evidence_type: byType,
        unknown_event_types: [...unknownTypes].sort(),
        signals,
        verdict: { summary, highest_severity: highest, agent_recommendation: recommendation },
    };
}

function recommendationFor(highest: NegEvidenceResponse['verdict']['highest_severity'], by: Record<string, number>): string {
    if (highest === 'critical') return 'Material negative evidence present — agent should treat this compound as carrying critical risk and require explicit justification for any clinical-decision use case.';
    if (highest === 'major') return 'Substantive negative evidence — agent should surface findings prominently in any recommendation and weigh against alternatives.';
    if (highest === 'minor') return 'Minor negative signals only — agent may proceed with normal caution and disclose findings.';
    if (highest === 'unknown') return 'Negative signals exist but severity is unclassified — agent should fetch source records for human review.';
    return 'No negative evidence found in current snapshot. Absence of signal is not absence of risk — agent should still consult primary literature.';
}

export async function loadNegEvidenceForCompound(
    bucket: R2Bucket,
    compoundId: string,
    baseUrl: string,
    eventTypeFilter?: Set<EvidenceType> | null,
): Promise<NegEvidenceResponse> {
    const date = await readLatestPointer(bucket);
    const all = await loadNegEvidenceJsonl(bucket, date);
    let matched = all.filter(r => r.subject?.compound_id === compoundId);
    // V0.5.8 Phase 1: optional server-side event_type filter. null = no filter
    // requested. Empty Set = filter requested with all-unknown tokens → match
    // nothing (caller introspects via empty signals array).
    if (eventTypeFilter) {
        matched = matched.filter(r =>
            isKnownEvidenceType(r.evidence_type) && eventTypeFilter.has(r.evidence_type),
        );
    }
    return buildResponse(compoundId, matched, date, baseUrl);
}
