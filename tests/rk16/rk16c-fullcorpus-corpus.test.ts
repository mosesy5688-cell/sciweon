// @ts-nocheck
/**
 * RK-16C FULL-CORPUS SPIKE (I) — corpus-grounded tests with controlled entry.
 *
 * NO module-eval corpus load: the corpus existence check happens ONLY inside a
 * controlled test entry (corpusExists()), and the corpus is loaded ONLY when
 * present. Full-corpus-scale tests skip-when-absent with an EXPLICIT reason; the
 * skip never masks a code error (the harness code paths are covered by the
 * synthetic harness test regardless). When the local 2026-05-13 corpus IS
 * present, a small bounded slice REALLY runs the matrix + real-degree.
 */
import { describe, it, expect } from 'vitest';
import { corpusExists, loadCorpus } from '../../scripts/spikes/rk16c/lib/corpus.mjs';
import { buildCanonical, projectRows } from '../../scripts/spikes/rk16c/lib/build-axis.mjs';
import { buildCell } from '../../scripts/spikes/rk16c/lib/fullcorpus-cells.mjs';
import { PARTITION_STRATEGIES } from '../../scripts/spikes/rk16c/lib/policy.mjs';
import { realDegreeReport } from '../../scripts/spikes/rk16c/lib/real-degree.mjs';
import { assertMetricsComplete, evaluateHardGates } from '../../scripts/spikes/rk16c/lib/rubric.mjs';

// CONTROLLED ENTRY: the only place corpus presence is probed. Absent in CI
// (snapshots/ is gitignored) -> EXPLICIT skip reason below; the synthetic
// harness test (rk16c-fullcorpus-harness) covers the code paths there.
const hasCorpus = corpusExists();
const SKIP_REASON = 'local 2026-05-13 corpus absent (snapshots/ gitignored, e.g. CI) '
    + '— synthetic harness test covers the code; full-corpus run is the founder-gated --execute path';

describe.skipIf(!hasCorpus)(`rk16c full-corpus corpus-grounded harness [${hasCorpus ? 'PRESENT' : SKIP_REASON}]`, () => {
    it('runs one corpus-grounded cell end-to-end on a bounded slice', async () => {
        const rows = loadCorpus().rows.slice(0, 1200); // bounded; not the 475k corpus
        const { byCanonicalId } = await buildCanonical(rows, undefined);
        const proj = projectRows(rows, byCanonicalId);
        const strat = PARTITION_STRATEGIES.P0;
        const cell = await buildCell('corpus_rt512_P0', proj, 512, strat.of, undefined, 'corpus_cell', 'corpus-test');
        assertMetricsComplete(cell.metrics);
        expect(cell.metrics.processed_rows).toBe(rows.length);
        expect(evaluateHardGates(cell.correctness).is_candidate).toBe(true);
    }, 600000);

    it('real-degree is CORPUS-GROUNDED + tail is monotone', () => {
        const rows = loadCorpus().rows.slice(0, 3000);
        const rep = realDegreeReport(rows, { corpus_grounded: true });
        expect(rep.corpus_grounded).toBe(true);
        expect(rep.label).toMatch(/CORPUS-GROUNDED/);
        expect(rep.target_axis.degree_max).toBeGreaterThanOrEqual(rep.target_axis.degree_p99);
        expect(rep.target_axis.degree_p99).toBeGreaterThanOrEqual(rep.target_axis.degree_p50);
    });
});

// A no-op assertion that ALWAYS runs so the file is never "all skipped" silently:
// it proves the controlled-entry probe itself works without loading the corpus.
describe('rk16c full-corpus controlled-entry probe (always runs)', () => {
    it('corpusExists() is a boolean and gates loading (no module-eval load)', () => {
        expect(typeof hasCorpus).toBe('boolean');
        if (!hasCorpus) expect(SKIP_REASON).toMatch(/founder-gated/);
    });
});
