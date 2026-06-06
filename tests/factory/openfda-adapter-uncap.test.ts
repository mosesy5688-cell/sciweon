// @ts-nocheck
/**
 * PR-T1.1a: openfda-adapter uncap -- adapter UNSLICE + 1000-limit + R5
 * boxed_warnings[] + R3 truncated flags. Global fetch mocked (no network).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    fetchLabelsByUnii, fetchFaersSignalsByUnii, fetchRecallsByUnii, aggregateSignals,
} from '../../scripts/ingestion/adapters/openfda-adapter.js';

function makeResponse(status, body = {}, headers = {}) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
    };
}

describe('adapter uncap: FAERS default limit 1000', () => {
    let savedFetch;
    beforeEach(() => { savedFetch = globalThis.fetch; process.env.OPENFDA_API_KEY = 'k'; });
    afterEach(() => { globalThis.fetch = savedFetch; delete process.env.OPENFDA_API_KEY; });

    it('FAERS URL requests limit=1000 by default (uncap)', async () => {
        let url;
        globalThis.fetch = vi.fn(async (u) => { url = String(u); return makeResponse(200, { results: [] }); });
        await fetchFaersSignalsByUnii('U1');
        expect(url).toContain('limit=1000');
    });
});

describe('aggregateSignals: UNSLICE (preserve-all, no 20-cap)', () => {
    it('keeps ALL application_numbers / pharm_class (no slice to 20)', () => {
        const labels = Array.from({ length: 1 }, () => ({
            openfda: {
                application_number: Array.from({ length: 33 }, (_, i) => `ANDA${i}`),
                pharm_class_epc: Array.from({ length: 39 }, (_, i) => `EPC${i}`),
                pharm_class_moa: Array.from({ length: 11 }, (_, i) => `MOA${i}`),
            },
        }));
        const out = aggregateSignals(labels, []);
        expect(out.application_numbers.length).toBe(33);   // was sliced to 20
        expect(out.pharm_class_epc.length).toBe(39);
        expect(out.pharm_class_moa.length).toBe(11);
    });
});

describe('R5 boxed_warnings[]: ALL warnings captured, full text, dual-write', () => {
    it('collects every boxed warning across all labels (no 1-of-N drop)', () => {
        const labels = [
            { boxed_warning: ['WARN A1', 'WARN A2'] },
            { boxed_warning: ['WARN B1'] },
        ];
        const out = aggregateSignals(labels, []);
        expect(out.boxed_warnings.map(w => w.text)).toEqual(['WARN A1', 'WARN A2', 'WARN B1']);
        // back-compat: boxed_warning_text = the FIRST.
        expect(out.boxed_warning_text).toBe('WARN A1');
        expect(out.has_boxed_warning).toBe(true);
    });

    it('full text -- NO slice to 4000 (the 40000 schema cap bounds it)', () => {
        const big = 'x'.repeat(5000);
        const out = aggregateSignals([{ boxed_warning: [big] }], []);
        expect(out.boxed_warnings[0].text.length).toBe(5000);
        expect(out.boxed_warning_text.length).toBe(5000);
    });

    it('no boxed warning -> empty array + null text', () => {
        const out = aggregateSignals([{ openfda: {} }], []);
        expect(out.boxed_warnings).toEqual([]);
        expect(out.boxed_warning_text).toBeNull();
        expect(out.has_boxed_warning).toBe(false);
    });
});

describe('R3 recall severity recompute over FULL set + truncated flags', () => {
    it('most_severe_recall_class recomputed over ALL recalls (no false-clean)', () => {
        // A Class I at "rank 11" (would be missed by the old limit-10 single page).
        const recalls = [
            ...Array.from({ length: 10 }, () => ({ classification: 'Class III' })),
            { classification: 'Class I' },   // the 11th -- the false-clean fix.
        ];
        const out = aggregateSignals([], recalls);
        expect(out.recall_count).toBe(11);
        expect(out.most_severe_recall_class).toBe('Class I');
    });

    it('label_truncated / recall_truncated flags propagate when set', () => {
        const out = aggregateSignals([{ boxed_warning: ['w'] }], [{ classification: 'Class II' }], {
            labelTruncated: true, recallTruncated: true,
        });
        expect(out.label_truncated).toBe(true);
        expect(out.recall_truncated).toBe(true);
    });

    it('truncated flags absent when not set', () => {
        const out = aggregateSignals([{ boxed_warning: ['w'] }], []);
        expect(out.label_truncated).toBeUndefined();
        expect(out.recall_truncated).toBeUndefined();
    });
});
