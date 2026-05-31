// @ts-nocheck
/**
 * PR-MD-2a: buildCorpusAddList (pure) + emitCorpusAddList env-gate.
 * Locks the FULL (not Top-N) target-UNII artifact shape + the slice_not_world caveat
 * (harm-side target; addressability measured in 2b).
 */

import { describe, it, expect } from 'vitest';
import { buildCorpusAddList, emitCorpusAddList } from '../../scripts/factory/lib/corpus-add-list-emit.js';

const rl = (not_in_corpus_full, corpus_fixable) => ({
    buckets: { not_in_corpus_full },
    labelProductivity: { corpus_fixable },
});

describe('buildCorpusAddList', () => {
    it('builds the full target set: deduped+sorted UNII union, rxcui count, corpus_fixable', () => {
        const a = buildCorpusAddList(rl([
            { rxcui: 'R1', uniis: ['UB', 'UA'] },
            { rxcui: 'R2', uniis: ['UA'] },          // UA shared -> deduped in union
            { rxcui: 'R3', uniis: ['UC'] },
        ], 236));
        expect(a.target_rxcui_count).toBe(3);
        expect(a.target_uniis).toEqual(['UA', 'UB', 'UC']);   // deduped + sorted
        expect(a.corpus_fixable_labels).toBe(236);
        expect(a.not_in_corpus).toHaveLength(3);              // full passthrough
        expect(a.schema_version).toBe(1);
        expect(a.note).toMatch(/PR-MD-2b/);                   // slice_not_world caveat present
    });

    it('safe defaults on empty / missing input', () => {
        const a = buildCorpusAddList({});
        expect(a.target_rxcui_count).toBe(0);
        expect(a.target_uniis).toEqual([]);
        expect(a.corpus_fixable_labels).toBe(null);
    });
});

describe('emitCorpusAddList', () => {
    it('env-gated: returns false (skips, never throws) when R2 env is absent', async () => {
        const saved = { ...process.env };
        for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete process.env[k];
        const ok = await emitCorpusAddList(buildCorpusAddList(rl([], 0)));
        expect(ok).toBe(false);
        Object.assign(process.env, saved);
    });
});
