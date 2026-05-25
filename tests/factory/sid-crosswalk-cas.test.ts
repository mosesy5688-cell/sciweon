// @ts-nocheck
// Phase 1.1c CAS-aware crosswalk extension tests (architect-review defect-1 fix).
// Separated from sid-crosswalk.test.ts to keep both under the 250-line cap.
import { describe, it, expect } from 'vitest';
import {
    buildPutCrosswalkParams,
    isPreconditionFailed,
    MAX_CROSSWALK_CAS_RETRIES,
    crosswalkKey,
} from '../../scripts/factory/lib/sid-crosswalk.js';

describe('buildPutCrosswalkParams (Phase 1.1c CAS-aware extension)', () => {
    const BUF = Buffer.from('test');

    it('without ifMatch/ifNoneMatch -> unconditional (backward compat with Phase 1.1b-probe)', () => {
        const p = buildPutCrosswalkParams({ entityClass: 'small_molecule', compressedBuffer: BUF, bucket: 'b' });
        expect(p.IfMatch).toBeUndefined();
        expect(p.IfNoneMatch).toBeUndefined();
        expect(p.Key).toBe('state/sid-crosswalk/small_molecule.jsonl.zst');
        expect(p.Bucket).toBe('b');
        expect(p.Body).toBe(BUF);
        expect(p.ContentType).toBe('application/octet-stream');
    });

    it('with ifMatch -> IfMatch header set (CAS update)', () => {
        const p = buildPutCrosswalkParams({ entityClass: 'small_molecule', compressedBuffer: BUF, ifMatch: '"abc"', bucket: 'b' });
        expect(p.IfMatch).toBe('"abc"');
    });

    it('with ifNoneMatch=* -> IfNoneMatch header set (first-write protection)', () => {
        const p = buildPutCrosswalkParams({ entityClass: 'small_molecule', compressedBuffer: BUF, ifNoneMatch: '*', bucket: 'b' });
        expect(p.IfNoneMatch).toBe('*');
    });

    it('both set -> both pass through (caller responsibility to avoid contradiction)', () => {
        const p = buildPutCrosswalkParams({ entityClass: 'trial', compressedBuffer: BUF, ifMatch: 'x', ifNoneMatch: '*', bucket: 'b' });
        expect(p.IfMatch).toBe('x');
        expect(p.IfNoneMatch).toBe('*');
    });

    it('different entity_class routes to different Key', () => {
        const p = buildPutCrosswalkParams({ entityClass: 'trial', compressedBuffer: BUF, bucket: 'b' });
        expect(p.Key).toBe('state/sid-crosswalk/trial.jsonl.zst');
    });

    it('throws on non-buffer compressedBuffer', () => {
        expect(() => buildPutCrosswalkParams({ entityClass: 'small_molecule', compressedBuffer: 'string', bucket: 'b' })).toThrow(/compressedBuffer/);
    });

    it('throws on missing bucket', () => {
        expect(() => buildPutCrosswalkParams({ entityClass: 'small_molecule', compressedBuffer: BUF, bucket: '' })).toThrow(/bucket/);
    });

    it('throws on missing entityClass (propagated from crosswalkKey)', () => {
        expect(() => buildPutCrosswalkParams({ entityClass: '', compressedBuffer: BUF, bucket: 'b' })).toThrow(/entityClass/);
    });
});

describe('isPreconditionFailed', () => {
    it('AWS SDK PreconditionFailed name -> true', () => {
        expect(isPreconditionFailed({ name: 'PreconditionFailed' })).toBe(true);
    });

    it('$metadata.httpStatusCode 412 -> true', () => {
        expect(isPreconditionFailed({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    });

    it('other AWS error names -> false', () => {
        expect(isPreconditionFailed({ name: 'NoSuchKey' })).toBe(false);
        expect(isPreconditionFailed({ name: 'AccessDenied' })).toBe(false);
    });

    it('other HTTP statuses -> false', () => {
        expect(isPreconditionFailed({ $metadata: { httpStatusCode: 404 } })).toBe(false);
        expect(isPreconditionFailed({ $metadata: { httpStatusCode: 500 } })).toBe(false);
    });

    it('null/undefined -> false (no throw on falsy input)', () => {
        expect(isPreconditionFailed(null)).toBe(false);
        expect(isPreconditionFailed(undefined)).toBe(false);
    });

    it('empty object -> false', () => {
        expect(isPreconditionFailed({})).toBe(false);
    });
});

describe('crosswalkKey shardPrefix extension (Phase 1.5)', () => {
    it('no shardPrefix -> single-file layout (backward compat)', () => {
        expect(crosswalkKey('bioactivity')).toBe('state/sid-crosswalk/bioactivity.jsonl.zst');
    });
    it('shardPrefix=null -> single-file layout', () => {
        expect(crosswalkKey('bioactivity', null)).toBe('state/sid-crosswalk/bioactivity.jsonl.zst');
    });
    it('shardPrefix=ab -> sharded layout', () => {
        expect(crosswalkKey('bioactivity', 'ab')).toBe('state/sid-crosswalk/bioactivity/ab.jsonl.zst');
    });
    it('shardPrefix=00 valid', () => {
        expect(crosswalkKey('bioactivity', '00')).toBe('state/sid-crosswalk/bioactivity/00.jsonl.zst');
    });
    it('shardPrefix=ff valid', () => {
        expect(crosswalkKey('bioactivity', 'ff')).toBe('state/sid-crosswalk/bioactivity/ff.jsonl.zst');
    });
    it('invalid shardPrefix (uppercase) throws', () => {
        expect(() => crosswalkKey('bioactivity', 'AB')).toThrow(/shardPrefix/);
    });
    it('invalid shardPrefix (3 chars) throws', () => {
        expect(() => crosswalkKey('bioactivity', 'abc')).toThrow(/shardPrefix/);
    });
    it('invalid shardPrefix (non-hex) throws', () => {
        expect(() => crosswalkKey('bioactivity', 'g0')).toThrow(/shardPrefix/);
    });
    it('buildPutCrosswalkParams threads shardPrefix to Key', () => {
        const p = buildPutCrosswalkParams({ entityClass: 'bioactivity', compressedBuffer: Buffer.from('x'), bucket: 'b', shardPrefix: 'ab' });
        expect(p.Key).toBe('state/sid-crosswalk/bioactivity/ab.jsonl.zst');
    });
});

describe('MAX_CROSSWALK_CAS_RETRIES constant', () => {
    it('is a positive integer', () => {
        expect(Number.isInteger(MAX_CROSSWALK_CAS_RETRIES)).toBe(true);
        expect(MAX_CROSSWALK_CAS_RETRIES).toBeGreaterThan(0);
    });

    it('matches Phase 1.1b counter ledger MAX_CAS_RETRIES (=5, locked retry budget)', () => {
        expect(MAX_CROSSWALK_CAS_RETRIES).toBe(5);
    });
});
