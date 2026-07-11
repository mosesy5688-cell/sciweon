// @ts-nocheck
/**
 * RC-3B-P0B machine-enforced template policy: the committed policy hash is stable
 * + HEX64, matchFamily accepts the synthetic ops and rejects out-of-family
 * keys/prefixes, and a .gz key is NOT a GET_META (structural) instantiation.
 */
import { describe, it, expect } from 'vitest';
import {
    loadTemplatePolicy, templatePolicySha256, matchFamily,
    assertBucketAndEndpoint, isTemplateDerived, canonicalTemplatePolicy,
} from '../../scripts/rc3b-audit/template-policy.mjs';

const PREFIX = 'synthetic/prefix/';

describe('RC-3B-P0B template policy: stable hash', () => {
    it('templatePolicySha256 is HEX64 and stable across calls', () => {
        const a = templatePolicySha256();
        const b = templatePolicySha256(loadTemplatePolicy());
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).toBe(b);
    });

    it('canonicalTemplatePolicy sorts families + suffixes deterministically', () => {
        const tp = loadTemplatePolicy();
        const c = canonicalTemplatePolicy(tp);
        const ids = c.families.map((f) => f.family_id);
        expect(ids).toEqual([...ids].sort());
    });
});

describe('RC-3B-P0B template policy: matchFamily', () => {
    const tp = loadTemplatePolicy();

    it('accepts the synthetic LIST / GET_META / HEAD / RANGE ops', () => {
        expect(matchFamily(tp, { operation: 'LIST', prefix: PREFIX })).toBeTruthy();
        expect(matchFamily(tp, { operation: 'GET_META', key: `${PREFIX}manifest.json`, effectiveClass: 'STRUCTURAL_JSON' })).toBeTruthy();
        expect(matchFamily(tp, { operation: 'HEAD', key: `${PREFIX}data.jsonl.gz`, effectiveClass: 'MONOLITHIC_GZIP' })).toBeTruthy();
        expect(matchFamily(tp, { operation: 'RANGE', key: `${PREFIX}fused-shard-000.bin`, effectiveClass: 'NXVF_SHARD' })).toBeTruthy();
    });

    it('rejects an out-of-family prefix and an out-of-family key', () => {
        expect(matchFamily(tp, { operation: 'LIST', prefix: 'other/prefix/' })).toBeNull();
        expect(matchFamily(tp, { operation: 'GET_META', key: 'other/prefix/manifest.json', effectiveClass: 'STRUCTURAL_JSON' })).toBeNull();
    });

    it('a .gz key is NOT a GET_META (structural) instantiation', () => {
        expect(matchFamily(tp, { operation: 'GET_META', key: `${PREFIX}data.jsonl.gz`, effectiveClass: 'STRUCTURAL_JSON' })).toBeNull();
    });

    it('a RANGE op with a non-NXVF effective class does not match', () => {
        expect(matchFamily(tp, { operation: 'RANGE', key: `${PREFIX}fused-shard-000.bin`, effectiveClass: 'MONOLITHIC_GZIP' })).toBeNull();
    });
});

describe('RC-3B-P0B template policy: bucket/endpoint + helpers', () => {
    const tp = loadTemplatePolicy();
    it('assertBucketAndEndpoint accepts the allowlisted pair and rejects others', () => {
        expect(() => assertBucketAndEndpoint(tp, { bucket: 'rc3b-synthetic-bucket', endpoint: 'synthetic-account' })).not.toThrow();
        expect(() => assertBucketAndEndpoint(tp, { bucket: 'evil-bucket', endpoint: 'synthetic-account' })).toThrow(/bucket/);
        expect(() => assertBucketAndEndpoint(tp, { bucket: 'rc3b-synthetic-bucket', endpoint: 'evil-account' })).toThrow(/endpoint/);
    });
    it('isTemplateDerived reports the governed operations', () => {
        expect(isTemplateDerived(tp, 'GET_META')).toBe(true);
        expect(isTemplateDerived(tp, 'DELETE')).toBe(false);
    });
});
