/**
 * Tests for V0.5.8 Wave C1-3 Phase 1 — repurposing aggregator pure helpers.
 *
 * Pure summarizers only. The synthesized verdict was REMOVED by the P0 public
 * scientific-safety repair; see the regression guard below. Full R2 integration
 * (loader orchestration) is exercised post-merge via the live REST endpoint.
 */

import { describe, it, expect } from 'vitest';
import {
    summarizeTrials,
    summarizeBioactivities,
    summarizeRetracted,
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

// ---------------------------------------------------------------------------
// P0 PUBLIC SCIENTIFIC-SAFETY REPAIR regression guard.
//
// `decideRepurposingVerdict` has been REMOVED. It graded a compound
// strong/mixed/weak/none and, on a threshold of ONE critical signal, returned
// "Repurposing is not viable without explicit risk-benefit reassessment" --
// a clinical-decision-adjacent adjudication Sciweon does not make.
//
// These tests exist so the verdict cannot be reintroduced silently: the module
// must export no verdict decider, and the response must carry an evidence-use
// boundary instead.
// ---------------------------------------------------------------------------
describe('no synthesized repurposing verdict is emitted', () => {
    it('the module exports no verdict decider', async () => {
        const mod = await import('../../src/worker/lib/repurposing-aggregator') as Record<string, unknown>;
        expect(mod.decideRepurposingVerdict).toBeUndefined();
        expect(Object.keys(mod).some(k => /verdict/i.test(k))).toBe(false);
    });

    it('the aggregator source carries no repurposing_signal grade or recommendation string', async () => {
        const fs = await import('node:fs/promises');
        const src = await fs.readFile('src/worker/lib/repurposing-aggregator.ts', 'utf8');
        // The removal note may name these; executable code must not assign them.
        expect(src).not.toMatch(/repurposing_signal:\s*'(strong|mixed|weak|none)'/);
        expect(src).not.toMatch(/recommendation:\s*'/);
        expect(src).not.toContain('risk-benefit reassessment');
    });

    it('exposes an evidence-use boundary with causality and incidence disclaimed', async () => {
        const { evidenceUseBoundary } = await import('../../src/worker/lib/neg-evidence-response');
        const b = evidenceUseBoundary();
        expect(b.research_use_only).toBe(true);
        expect(b.clinical_decision_support).toBe(false);
        expect(b.causality_assessed).toBe(false);
        expect(b.incidence_or_rate_derivable).toBe(false);
        expect(b.spontaneous_report_caveat).toContain('cannot establish causation');
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
