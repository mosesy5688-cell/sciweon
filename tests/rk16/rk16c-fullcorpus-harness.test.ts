// @ts-nocheck
/**
 * RK-16C FULL-CORPUS SPIKE (I) — harness end-to-end + deterministic replay +
 * rubric gates + real-degree (G). REALLY runs the matrix on a SMALL synthetic
 * fixture (LABELED), then: (a) full 12-cell matrix; (b) same fixture+code+matrix
 * => identical output hashes; (c) a failing hard-gate disqualifies a cell;
 * (d) the NO-RATIFIABLE-CANDIDATE path; (e) real-degree classifies the max
 * degree. OFFLINE/FIXTURE; no network, no module-eval corpus load. <=250 lines.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'crypto';
import { makeSyntheticFixture } from '../../scripts/spikes/rk16c/lib/fixture-source.mjs';
import { buildCanonical, projectRows } from '../../scripts/spikes/rk16c/lib/build-axis.mjs';
import { runMatrix } from '../../scripts/spikes/rk16c/run-fullcorpus.mjs';
import {
    evaluateHardGates, selectCandidate, assertMetricsComplete,
    HARD_GATES, COMPARATIVE_METRICS, RUBRIC_VERSION,
} from '../../scripts/spikes/rk16c/lib/rubric.mjs';
import { realDegreeReport, classifyMaxDegree, degreeDistribution }
    from '../../scripts/spikes/rk16c/lib/real-degree.mjs';

let PROJ; // small synthetic projection rows

beforeAll(async () => {
    const rows = makeSyntheticFixture(600); // small + bounded for CI
    const { byCanonicalId } = await buildCanonical(rows, undefined);
    PROJ = { rows, proj: projectRows(rows, byCanonicalId) };
}, 600000);

function hashCells(cells) {
    // hash structural correctness + page/partition shape (deterministic surface).
    const surface = cells.map((c) => ({
        id: c.id, correctness: c.correctness,
        partition_count: c.metrics.partition_count, page_count: c.metrics.page_count,
        peak_heap: c.metrics.peak_heap, cursor_rounds: c.metrics.cursor_rounds,
    }));
    return createHash('sha256').update(JSON.stringify(surface)).digest('hex');
}

describe('rk16c full-corpus matrix harness (>=12 cells)', () => {
    it('runs the full 12-cell matrix; every cell carries all metrics', async () => {
        const cells = await runMatrix(PROJ.proj, undefined);
        expect(cells.length).toBe(12);
        for (const c of cells) {
            assertMetricsComplete(c.metrics);
            for (const m of COMPARATIVE_METRICS) expect(c.metrics[m]).toBeDefined();
            expect(c.metrics.processed_rows).toBe(c.metrics.total_rows);
        }
    }, 600000);
});

describe('rk16c deterministic replay (same fixture+code+matrix => same hashes)', () => {
    it('two runs over the same projection produce identical output hashes', async () => {
        const a = await runMatrix(PROJ.proj, undefined);
        const b = await runMatrix(PROJ.proj, undefined);
        expect(hashCells(a)).toBe(hashCells(b));
    }, 600000);
});

describe('rk16c rubric hard gates', () => {
    it('a passing cell is a candidate; a failing hard-gate disqualifies it', () => {
        const ok = {};
        for (const g of HARD_GATES) ok[g] = true;
        expect(evaluateHardGates(ok).is_candidate).toBe(true);
        const bad = { ...ok, no_silent_row_drop: false };
        const r = evaluateHardGates(bad);
        expect(r.is_candidate).toBe(false);
        expect(r.failed_gates).toContain('no_silent_row_drop');
    });

    it('selectCandidate => NO_RATIFIABLE_CANDIDATE when no cell passes', () => {
        const failing = [{
            id: 'x', correctness: { ...allTrue(), within_heap_ceiling: false },
            metrics: minMetrics({ over_heap_ceiling: true }),
        }];
        const sel = selectCandidate(failing);
        expect(sel.ratifiable).toBe(false);
        expect(sel.outcome).toBe('NO_RATIFIABLE_CANDIDATE');
        expect(sel.rubric_version).toBe(RUBRIC_VERSION);
    });

    it('selectCandidate => CANDIDATE_SELECTED + ranking when cells pass', () => {
        const cells = [
            { id: 'simple', correctness: allTrue(), metrics: minMetrics({ partition_count: 1, page_count: 4, cursor_rounds: 2 }) },
            { id: 'complex', correctness: allTrue(), metrics: minMetrics({ partition_count: 9, page_count: 80, cursor_rounds: 30 }) },
        ];
        const sel = selectCandidate(cells);
        expect(sel.ratifiable).toBe(true);
        expect(sel.outcome).toBe('CANDIDATE_SELECTED');
        expect(sel.winner).toBe('simple'); // simpler structure + lower tail wins
    });
});

describe('rk16c real-degree (G) classifies max degree from the corpus itself', () => {
    it('reports tail + classifies the hot target as legit high degree', () => {
        const rep = realDegreeReport(PROJ.rows, { corpus_grounded: false });
        expect(rep.corpus_grounded).toBe(false);
        expect(rep.label).toMatch(/SYNTHETIC/);
        expect(rep.target_axis.degree_max).toBeGreaterThan(rep.target_axis.degree_p50);
        expect(['legit_high_degree', 'duplicate_edge', 'anomaly_sentinel_key'])
            .toContain(rep.target_max_degree_classification.classification);
        // the synthetic HOT target has distinct member ids -> legit, no dup edges.
        expect(rep.target_max_degree_classification.duplicate_edge_count).toBe(0);
    });

    it('detects a duplicate-edge anomaly', () => {
        const rows = [
            { id: 'a', target_id: 'T', is_active: true },
            { id: 'a', target_id: 'T', is_active: true }, // illegal duplicate edge
            { id: 'b', target_id: 'T', is_active: false },
        ];
        const dist = degreeDistribution(rows, (r) => `chembl:${r.target_id}`);
        const cls = classifyMaxDegree(rows, (r) => `chembl:${r.target_id}`, dist.max_degree_key, (r) => r.id);
        expect(cls.duplicate_edge_count).toBe(1);
        expect(cls.classification).toBe('duplicate_edge');
    });
});

function allTrue() { const o = {}; for (const g of HARD_GATES) o[g] = true; return o; }
function minMetrics(over = {}) {
    const m = {};
    for (const k of COMPARATIVE_METRICS) m[k] = 1;
    m.rows_per_partition_max = 10; m.rows_per_partition_p999 = 2; m.peak_heap = 1024;
    return { ...m, over_heap_ceiling: false, over_read_budget: false, ...over };
}
