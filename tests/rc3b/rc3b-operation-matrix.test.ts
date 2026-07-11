// @ts-nocheck
/**
 * RC-3B-P0B CLASS-C operation/class matrix (CHANGE D). decideOperation admits a
 * payload class (MONOLITHIC_GZIP/ZSTD, PAYLOAD_JSONL) ONLY for HEAD; GET_META /
 * RANGE / full GET of a payload class are DENIED. STRUCTURAL_JSON is GET_META-
 * only; NXVF_SHARD is RANGE-only. At the client level a payload key can be HEAD-ed
 * ONLY via an exact CLASS-C HEAD family with an explicit object_class -- an
 * object_class:null non-LIST family cannot match (no bypass).
 */
import { describe, it, expect } from 'vitest';
import { decideOperation } from '../../scripts/rc3b-audit/operation-matrix.mjs';
import { matchFamily, nullObjectClassNonListFamilies } from '../../scripts/rc3b-audit/template-policy.mjs';
import { basePlan, buildClient, stdResponder, SYNTH_TEMPLATE_POLICY } from './rc3b-fixtures';

const allow = (o, c) => decideOperation({ operation: o, effectiveClass: c }).allow;

describe('RC-3B-P0B operation-matrix: decideOperation (pure)', () => {
    it('STRUCTURAL_JSON is GET_META-only', () => {
        expect(allow('GET_META', 'STRUCTURAL_JSON')).toBe(true);
        expect(allow('HEAD', 'STRUCTURAL_JSON')).toBe(false);
        expect(allow('RANGE', 'STRUCTURAL_JSON')).toBe(false);
        expect(allow('GET', 'STRUCTURAL_JSON')).toBe(false);
    });
    it('NXVF_SHARD is RANGE-only', () => {
        expect(allow('RANGE', 'NXVF_SHARD')).toBe(true);
        expect(allow('HEAD', 'NXVF_SHARD')).toBe(false);
        expect(allow('GET_META', 'NXVF_SHARD')).toBe(false);
    });
    for (const cls of ['MONOLITHIC_GZIP', 'MONOLITHIC_ZSTD', 'PAYLOAD_JSONL']) {
        it(`${cls} is HEAD-only (GET_META / RANGE / GET denied)`, () => {
            expect(allow('HEAD', cls)).toBe(true);
            expect(allow('GET_META', cls)).toBe(false);
            expect(allow('RANGE', cls)).toBe(false);
            expect(allow('GET', cls)).toBe(false);
        });
    }
    it('an unknown class default-denies', () => {
        expect(allow('HEAD', 'WHAT_CLASS')).toBe(false);
        expect(allow('LIST', undefined)).toBe(false);
    });
});

describe('RC-3B-P0B operation-matrix: matchFamily rejects object_class:null non-LIST families', () => {
    const nullHead = { ...SYNTH_TEMPLATE_POLICY, families: SYNTH_TEMPLATE_POLICY.families.map((f) => (f.operation === 'HEAD' ? { ...f, object_class: null } : f)) };
    it('a null object_class HEAD family cannot match a HEAD op', () => {
        expect(matchFamily(nullHead, { operation: 'HEAD', key: 'p/a.gz', effectiveClass: 'MONOLITHIC_GZIP' })).toBeNull();
    });
    it('nullObjectClassNonListFamilies flags the offending family id', () => {
        expect(nullObjectClassNonListFamilies(nullHead)).toContain('test-head');
        expect(nullObjectClassNonListFamilies(SYNTH_TEMPLATE_POLICY)).toEqual([]);
    });
});

describe('RC-3B-P0B operation-matrix: client-level CLASS-C enforcement', () => {
    it('CLASS-C HEAD via an exact CLASS-C HEAD family IS allowed (1 call)', async () => {
        const plan = basePlan({ class_c_head_keys: ['p/data.jsonl.gz'] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        const out = await rc.headExactKey('p/data.jsonl.gz');
        expect(calls.length).toBe(1);
        expect(calls[0].ctor).toBe('HeadObjectCommand');
        expect(out.key).toBe('p/data.jsonl.gz');
    });

    it('CLASS-C GET_META (no-Range on a payload key) -> 0 network', async () => {
        const plan = basePlan({ structural_keys: ['p/data.jsonl.gz'], object_class_map: { 'p/data.jsonl.gz': 'MONOLITHIC_GZIP' } });
        const { rc, calls, budget } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.getStructuralMetadata('p/data.jsonl.gz')).rejects.toThrow(/no Range|forbidden|not seekable/);
        expect(calls.length).toBe(0);
        expect(budget.counters.rejectedBeforeNetwork).toBe(1);
    });

    it('CLASS-C RANGE (payload) -> 0 network', async () => {
        const plan = basePlan({ class_x_targets: [{ key: 'p/x.gz', offset: 0, length: 64, object_class: 'MONOLITHIC_GZIP' }] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.readLocatorBoundRange('p/x.gz', 0, 64)).rejects.toThrow(/gzip|not seekable/);
        expect(calls.length).toBe(0);
    });

    it('object_class:null HEAD family (spoof) -> HEAD rejected, 0 network', async () => {
        const spoof = { ...SYNTH_TEMPLATE_POLICY, families: SYNTH_TEMPLATE_POLICY.families.map((f) => (f.operation === 'HEAD' ? { ...f, object_class: null } : f)) };
        const plan = basePlan({ class_c_head_keys: ['p/a.gz'] });
        const { rc, calls, budget } = buildClient(plan, { templatePolicy: spoof, responder: stdResponder() });
        await expect(rc.headExactKey('p/a.gz')).rejects.toThrow(/CLASS-C HEAD family|FORMAT_NOT_SEEKABLE/);
        expect(calls.length).toBe(0);
        expect(budget.counters.rejectedBeforeNetwork).toBe(1);
    });
});
