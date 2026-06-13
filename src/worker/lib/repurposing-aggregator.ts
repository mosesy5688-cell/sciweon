/**
 * V0.5.8 Wave C1-3 Phase 1 — repurposing evidence aggregator.
 *
 * Fuses 3 evidence layers in one call:
 *   positive  = progressed trials + active bioactivities
 *   negative  = NegEvidence signals (C1-1 typed taxonomy)
 *   retracted = papers with is_retracted=true
 *
 * Agent UX: replaces 4 separate round-trips (/trials + /bioactivities +
 * /negative-evidence + /papers + filter) with one canonical call that also
 * synthesizes a single repurposing_signal verdict (strong/mixed/weak/none).
 *
 * Pure summarizers + verdict are exported separately for unit testing.
 * The orchestrator wires loaders in parallel.
 */

import { fetchR2JsonText } from './r2-fetch';
import { loadTrialsForCompound } from './trial-loader';
import { loadBioactivitiesForCompound } from './bioactivity-loader';
import { loadPapersForCompound } from './paper-loader';
import { loadNegEvidenceSummary, type NegSummary } from './neg-evidence-loader';
import { type SnapshotContext, loadSnapshotContext } from './snapshot-context';
import { toSourceLoadError } from './source-load-error';

const POSITIVE_TRIAL_STATUSES = new Set([
    'RECRUITING', 'ACTIVE_NOT_RECRUITING', 'ENROLLING_BY_INVITATION', 'COMPLETED', 'AVAILABLE',
]);
const ACTIVE_TRIAL_STATUSES = new Set([
    'RECRUITING', 'ACTIVE_NOT_RECRUITING', 'ENROLLING_BY_INVITATION', 'AVAILABLE',
]);

export interface RepurposingSummary {
    positive: {
        trials: {
            active_count: number;
            completed_count: number;
            total: number;
            examples: Array<{ nct_id: string; status: string; phase: number | null }>;
        };
        bioactivities: {
            active_count: number;
            total: number;
            examples: Array<{ id: string; target_id: string; value: number | null; unit: string | null }>;
        };
    };
    negative: {
        signals_count: number;
        signals_by_severity: { critical: number; major: number; minor: number; unknown: number };
        examples: Array<{ id: string; evidence_type: string; severity: string }>;
    };
    retracted: {
        papers_count: number;
        examples: Array<{ id: string; pmid: string | null; doi: string | null; title: string | null }>;
    };
}

export interface RepurposingResponse {
    compound: { id: string; url: string };
    snapshot_date: string | null;
    summary: RepurposingSummary;
    verdict: {
        repurposing_signal: 'strong' | 'mixed' | 'weak' | 'none';
        recommendation: string;
    };
}

export function summarizeTrials(trials: Record<string, unknown>[]): RepurposingSummary['positive']['trials'] {
    let active = 0, completed = 0;
    const examples: RepurposingSummary['positive']['trials']['examples'] = [];
    for (const t of trials ?? []) {
        const status = String(t.status ?? '');
        if (status === 'COMPLETED') completed++;
        else if (ACTIVE_TRIAL_STATUSES.has(status)) active++;
        else continue;
        if (examples.length < 5) {
            examples.push({
                nct_id: String(t.nct_id ?? ''),
                status,
                phase: typeof t.phase === 'number' ? t.phase : null,
            });
        }
    }
    return { active_count: active, completed_count: completed, total: active + completed, examples };
}

export function summarizeBioactivities(bios: Record<string, unknown>[]): RepurposingSummary['positive']['bioactivities'] {
    let active = 0;
    const examples: RepurposingSummary['positive']['bioactivities']['examples'] = [];
    for (const b of bios ?? []) {
        if (b.is_active === true) {
            active++;
            if (examples.length < 5) {
                examples.push({
                    id: String(b.id ?? ''),
                    target_id: String(b.target_id ?? ''),
                    value: typeof b.value === 'number' ? b.value : null,
                    unit: typeof b.unit === 'string' ? b.unit : null,
                });
            }
        }
    }
    return { active_count: active, total: active, examples };
}

export function summarizeRetracted(papers: Record<string, unknown>[]): RepurposingSummary['retracted'] {
    const retracted = (papers ?? []).filter(p => p.is_retracted === true);
    const examples = retracted.slice(0, 5).map(p => ({
        id: String(p.id ?? ''),
        pmid: typeof p.pmid === 'string' ? p.pmid : null,
        doi: typeof p.doi === 'string' ? p.doi : null,
        title: typeof p.title === 'string' ? p.title : null,
    }));
    return { papers_count: retracted.length, examples };
}

export function summarizeNegative(neg: NegSummary): RepurposingSummary['negative'] {
    // PR-T1.1-LEVER: the summary loader returns rollups (manifest entry) + a
    // few first-page examples — already exactly the negative-summary shape, so
    // this is now a pass-through that maps the {critical,major,minor,unknown}
    // rollup. No full neg-evidence load occurs on the aggregator path.
    return {
        signals_count: neg.signals_count,
        signals_by_severity: neg.signals_by_severity,
        examples: neg.examples.slice(0, 5).map(s => ({
            id: s.id, evidence_type: String(s.evidence_type), severity: String(s.severity),
        })),
    };
}

export function decideRepurposingVerdict(summary: RepurposingSummary): RepurposingResponse['verdict'] {
    const posTotal = summary.positive.trials.total + summary.positive.bioactivities.total;
    const negTotal = summary.negative.signals_count;
    const critical = summary.negative.signals_by_severity.critical;
    const retracted = summary.retracted.papers_count;

    if (critical > 0) {
        return {
            repurposing_signal: 'none',
            recommendation: 'Critical negative signal present (drug withdrawal / black box). Repurposing is not viable without explicit risk-benefit reassessment.',
        };
    }
    if (posTotal === 0 && negTotal === 0 && retracted === 0) {
        return {
            repurposing_signal: 'none',
            recommendation: 'No repurposing evidence on file. Insufficient data to recommend.',
        };
    }
    if (posTotal === 0 && retracted > 0) {
        return {
            repurposing_signal: 'weak',
            recommendation: 'No positive evidence; only retracted-paper signals present. Treat any historical claim with caution.',
        };
    }
    if (summary.positive.trials.total >= 2 && negTotal <= 2) {
        return {
            repurposing_signal: 'strong',
            recommendation: 'Multiple progressed trials and few negative signals — strong repurposing candidate.',
        };
    }
    if (posTotal > 0 && negTotal === 0) {
        return {
            repurposing_signal: 'strong',
            recommendation: 'Positive evidence present with no negative signals on record.',
        };
    }
    if (posTotal > 0 && negTotal > 2) {
        return {
            repurposing_signal: 'mixed',
            recommendation: 'Positive evidence weighed against multiple negative signals. Agent should surface both layers.',
        };
    }
    return {
        repurposing_signal: 'weak',
        recommendation: 'Sparse evidence; treat any single-source claim with caution.',
    };
}

export async function aggregateRepurposingEvidence(
    bucket: R2Bucket,
    compoundId: string,
    baseUrl: string,
): Promise<RepurposingResponse> {
    // RK-15 PR-A2: read latest.json EXACTLY ONCE at the request entry -> ONE
    // pinned dual-contract ctx, threaded into EVERY sub-loader (neg + trials +
    // bioactivities + papers). No sub-loader re-reads latest.json, so a composed
    // request reads the pointer once and pins one snapshot identity for all
    // layers. A SnapshotContractError (unknown/mixed/corrupt) PROPAGATES (LOUD —
    // never a partial/empty/'none' verdict). A plain absent/unreadable pointer is
    // a source READ failure: surface it as a typed SourceLoadError (LOUD, the
    // route maps it to a retryable 503) rather than degrading to a falsely-empty
    // verdict — the loaders can no longer best-effort over a missing pointer
    // because they all consume this one ctx.
    let ctx: SnapshotContext;
    try {
        ctx = await loadSnapshotContext(k => fetchR2JsonText(bucket, k));
    } catch (err) {
        if (err instanceof Error && err.name === 'SnapshotContractError') throw err;
        throw toSourceLoadError('snapshot-pointer', `compound:${compoundId}`, err);
    }
    const snapshotDate: string = ctx.snapshot_date;

    const [trials, bios, papers, neg] = await Promise.all([
        loadTrialsForCompound(bucket, ctx, compoundId),
        loadBioactivitiesForCompound(bucket, ctx, compoundId),
        loadPapersForCompound(bucket, ctx, compoundId),
        // PR-T1.1-LEVER: summary path only (manifest entry + first page), NOT
        // the full neg load — bounds the aggregator's heap too. Threaded the SAME
        // pinned ctx so all four layers describe ONE snapshot identity.
        loadNegEvidenceSummary(bucket, ctx, compoundId),
    ]);

    const summary: RepurposingSummary = {
        positive: {
            trials: summarizeTrials(trials),
            bioactivities: summarizeBioactivities(bios),
        },
        negative: summarizeNegative(neg),
        retracted: summarizeRetracted(papers),
    };

    return {
        compound: { id: compoundId, url: `${baseUrl}/api/v1/entity/${encodeURIComponent(compoundId)}` },
        snapshot_date: snapshotDate,
        summary,
        verdict: decideRepurposingVerdict(summary),
    };
    // Note: POSITIVE_TRIAL_STATUSES reserved for Phase 2 weighted-tier scoring.
    void POSITIVE_TRIAL_STATUSES;
}
