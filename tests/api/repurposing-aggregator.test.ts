/**
 * Tests for V0.5.8 Wave C1-3 Phase 1 — repurposing aggregator pure helpers.
 *
 * Pure summarizers + verdict decision. Full R2 integration (loader
 * orchestration) is exercised post-merge via the live REST endpoint;
 * Phase 2 may add mock-R2 integration tests once telemetry shapes the
 * verdict thresholds.
 */

import { describe, it, expect } from 'vitest';
import {
    summarizeTrials,
    summarizeBioactivities,
    summarizeRetracted,
    decideRepurposingVerdict,
    aggregateRepurposingEvidence,
    type RepurposingSummary,
} from '../../src/worker/lib/repurposing-aggregator';
import { SourceLoadError } from '../../src/worker/lib/source-load-error';

function emptySummary(): RepurposingSummary {
    return {
        positive: {
            trials: { active_count: 0, completed_count: 0, total: 0, examples: [] },
            bioactivities: { active_count: 0, total: 0, examples: [] },
        },
        negative: {
            signals_count: 0,
            signals_by_severity: { critical: 0, major: 0, minor: 0, unknown: 0 },
            examples: [],
        },
        retracted: { papers_count: 0, examples: [] },
    };
}

describe('summarizeTrials', () => {
    it('empty array -> all zeros', () => {
        const r = summarizeTrials([]);
        expect(r).toEqual({ active_count: 0, completed_count: 0, total: 0, examples: [] });
    });

    it('mix of RECRUITING + COMPLETED + TERMINATED -> active + completed counted, terminated excluded', () => {
        const trials = [
            { nct_id: 'NCT001', status: 'RECRUITING', phase: 2 },
            { nct_id: 'NCT002', status: 'COMPLETED', phase: 3 },
            { nct_id: 'NCT003', status: 'TERMINATED', phase: 1 },
            { nct_id: 'NCT004', status: 'ACTIVE_NOT_RECRUITING', phase: 2 },
            { nct_id: 'NCT005', status: 'WITHDRAWN', phase: 1 },
        ];
        const r = summarizeTrials(trials);
        expect(r.active_count).toBe(2);
        expect(r.completed_count).toBe(1);
        expect(r.total).toBe(3);
        expect(r.examples).toHaveLength(3);
    });
});

describe('summarizeBioactivities', () => {
    it('counts only is_active=true entries', () => {
        const bios = [
            { id: 'b1', target_id: 't1', value: 10, unit: 'nM', is_active: true },
            { id: 'b2', target_id: 't2', value: 1000, unit: 'nM', is_active: false },
            { id: 'b3', target_id: 't3', value: 50, unit: 'nM', is_active: true },
        ];
        const r = summarizeBioactivities(bios);
        expect(r.active_count).toBe(2);
        expect(r.total).toBe(2);
        expect(r.examples).toHaveLength(2);
    });

    it('empty array -> zero', () => {
        expect(summarizeBioactivities([]).active_count).toBe(0);
    });
});

describe('summarizeRetracted', () => {
    it('filters by is_retracted=true', () => {
        const papers = [
            { id: 'p1', pmid: '100', doi: '10.1/a', title: 'A', is_retracted: true },
            { id: 'p2', pmid: '101', doi: '10.1/b', title: 'B', is_retracted: false },
            { id: 'p3', pmid: '102', doi: '10.1/c', title: 'C', is_retracted: true },
        ];
        const r = summarizeRetracted(papers);
        expect(r.papers_count).toBe(2);
        expect(r.examples).toHaveLength(2);
    });

    it('all-non-retracted -> zero', () => {
        const papers = [
            { id: 'p1', is_retracted: false },
            { id: 'p2', is_retracted: false },
        ];
        expect(summarizeRetracted(papers).papers_count).toBe(0);
    });
});

describe('decideRepurposingVerdict', () => {
    it('critical negative signal -> none (regardless of positive count)', () => {
        const s = emptySummary();
        s.positive.trials.total = 10;
        s.positive.trials.active_count = 10;
        s.negative.signals_count = 1;
        s.negative.signals_by_severity.critical = 1;
        const v = decideRepurposingVerdict(s);
        expect(v.repurposing_signal).toBe('none');
        expect(v.recommendation).toContain('Critical');
    });

    it('3 positive trials + 0 negative -> strong', () => {
        const s = emptySummary();
        s.positive.trials.total = 3;
        s.positive.trials.active_count = 2;
        s.positive.trials.completed_count = 1;
        const v = decideRepurposingVerdict(s);
        expect(v.repurposing_signal).toBe('strong');
    });

    it('positive=1 + negative=5 -> mixed', () => {
        const s = emptySummary();
        s.positive.trials.total = 1;
        s.positive.trials.active_count = 1;
        s.negative.signals_count = 5;
        s.negative.signals_by_severity.major = 5;
        const v = decideRepurposingVerdict(s);
        expect(v.repurposing_signal).toBe('mixed');
    });

    it('0 positive + retracted only -> weak', () => {
        const s = emptySummary();
        s.retracted.papers_count = 2;
        const v = decideRepurposingVerdict(s);
        expect(v.repurposing_signal).toBe('weak');
        expect(v.recommendation).toContain('retracted');
    });

    it('all empty -> none', () => {
        const v = decideRepurposingVerdict(emptySummary());
        expect(v.repurposing_signal).toBe('none');
        expect(v.recommendation).toContain('No repurposing evidence');
    });

    it('positive >= 2 AND negative <= 2 -> strong (recommendation flags multiple trials)', () => {
        const s = emptySummary();
        s.positive.trials.total = 5;
        s.positive.trials.active_count = 3;
        s.positive.trials.completed_count = 2;
        s.negative.signals_count = 2;
        s.negative.signals_by_severity.minor = 2;
        const v = decideRepurposingVerdict(s);
        expect(v.repurposing_signal).toBe('strong');
        expect(v.recommendation).toContain('Multiple progressed trials');
    });
});

// ---------------------------------------------------------------------------
// RK-13 (SOURCE_FAILURE_CONTRACT, N-10) regression guard:
// a loader source-failure must PROPAGATE out of the aggregator (reject), NOT be
// caught-and-emptied into a falsely-empty 'none' verdict. The aggregator does
// not catch SourceLoadError; it lets it bubble to the route/MCP layer (which
// maps it to a retryable 502/503).
// ---------------------------------------------------------------------------
function makeMockBucket(store: Record<string, { size: number; bytes?: Uint8Array; etag: string }>) {
    return {
        async head(key: string) {
            const o = store[key];
            return o ? { size: o.size, etag: o.etag } : null;
        },
        async get(key: string) {
            const o = store[key];
            if (!o || !o.bytes) return null;
            return {
                etag: o.etag,
                async arrayBuffer() {
                    return o.bytes!.buffer.slice(o.bytes!.byteOffset, o.bytes!.byteOffset + o.bytes!.byteLength);
                },
            };
        },
    } as unknown as R2Bucket;
}

describe('aggregateRepurposingEvidence RK-13 source-failure propagation', () => {
    it('a loader source-failure PROPAGATES (rejects), never resolves to a "none" verdict', async () => {
        // Pointer absent -> every record loader's source read fails (and rejects
        // with a typed SourceLoadError). The aggregator must NOT swallow it into
        // empty arrays and decide 'none'; it must reject.
        const bucket = makeMockBucket({});
        const outcome = await aggregateRepurposingEvidence(bucket, 'CID:2244', 'https://sciweon.test')
            .then(v => ({ resolved: true, v }), e => ({ resolved: false, e }));
        expect(outcome.resolved).toBe(false);
        // and specifically a loader source-failure (not a generic crash).
        expect((outcome as { e: unknown }).e).toBeInstanceOf(SourceLoadError);
    });
});
