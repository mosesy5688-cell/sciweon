// @ts-nocheck
/**
 * REQUIRED CI GATE — neg-bucket-hash parity.
 *
 * The SAFETY endpoint (/compound/:id/negative-evidence) serves ONLY the
 * bucket computed by negBucketOf(key). If this hash ever drifts, the worker
 * loads the WRONG bucket's manifest, finds no entry, and returns an
 * authoritative `negative_signals_count: 0` — a FALSE-CLEAN on the
 * highest-stakes endpoint. These frozen golden vectors lock the hash:
 * any change to fnv1a32 / negBucketOf / NEG_BUCKET_COUNT breaks this test.
 *
 * The golden fnv1a32 values were cross-verified against an INDEPENDENT
 * Python reference implementation of FNV-1a 32-bit (not just self-consistent).
 */

import { describe, it, expect } from 'vitest';
import {
    NEG_BUCKET_COUNT,
    negKeyOf,
    fnv1a32,
    negBucketOf,
} from '../../src/lib/neg-bucket-hash.js';

// Frozen golden vectors over real key strings. DO NOT edit a value to make a
// failing test pass — a changed value means the partition moved, which would
// silently false-clean the safety endpoint. If the hash MUST change, that is
// a deliberate re-bucketing migration requiring a new snapshot republish.
const GOLDEN = Object.freeze([
    { key: 'sciweon::compound::CID:119', fnv: 3853446997, bucket: 853 },
    { key: 'sciweon::compound::CID:2244', fnv: 2715382764, bucket: 1004 },
    { key: 'sciweon::paper::W3046275966', fnv: 2628979120, bucket: 432 },
    { key: 'sciweon::trial::NCT05172570', fnv: 1342466119, bucket: 71 },
    { key: 'sciweon::bioactivity::CHEMBL_ACTIVITY:12345', fnv: 3120262710, bucket: 566 },
    { key: 'sciweon::target::UNIPROT:P12345', fnv: 1346220798, bucket: 766 },
    { key: 'sciweon::neg::orphan::sciweon::neg::retraction::10.1/abc', fnv: 3242256709, bucket: 325 },
]);

describe('neg-bucket-hash — frozen parity gate', () => {
    it('NEG_BUCKET_COUNT is 1024 (1024 buckets)', () => {
        expect(NEG_BUCKET_COUNT).toBe(1024);
    });

    it('fnv1a32 matches the frozen golden values (cross-checked vs Python FNV-1a)', () => {
        for (const g of GOLDEN) {
            expect(fnv1a32(g.key)).toBe(g.fnv);
        }
    });

    it('negBucketOf matches the frozen golden buckets', () => {
        for (const g of GOLDEN) {
            expect(negBucketOf(g.key)).toBe(g.bucket);
        }
    });

    it('every bucket is in [0, NEG_BUCKET_COUNT)', () => {
        for (const g of GOLDEN) {
            const b = negBucketOf(g.key);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(NEG_BUCKET_COUNT);
        }
    });

    it('fnv1a32 returns an unsigned 32-bit integer', () => {
        for (const g of GOLDEN) {
            const h = fnv1a32(g.key);
            expect(Number.isInteger(h)).toBe(true);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThanOrEqual(0xffffffff);
        }
    });
});

describe('negKeyOf — subject fallback chain, NEVER null', () => {
    it('prefers subject.compound_id', () => {
        expect(negKeyOf({ subject: { compound_id: 'sciweon::compound::CID:119', trial_id: 'sciweon::trial::NCT1' } }))
            .toBe('sciweon::compound::CID:119');
    });

    it('falls through to trial_id when compound_id absent', () => {
        expect(negKeyOf({ subject: { trial_id: 'sciweon::trial::NCT05172570' } }))
            .toBe('sciweon::trial::NCT05172570');
    });

    it('falls through to bioactivity_id, then paper_id, then target_id', () => {
        expect(negKeyOf({ subject: { bioactivity_id: 'sciweon::bioactivity::B1' } })).toBe('sciweon::bioactivity::B1');
        expect(negKeyOf({ subject: { paper_id: 'sciweon::paper::W3046275966' } })).toBe('sciweon::paper::W3046275966');
        expect(negKeyOf({ subject: { target_id: 'sciweon::target::UNIPROT:P12345' } })).toBe('sciweon::target::UNIPROT:P12345');
    });

    it('treats empty-string subject fields as absent (skips to next non-empty)', () => {
        expect(negKeyOf({ id: 'sciweon::neg::trial::NCT9', subject: { compound_id: '', trial_id: 'sciweon::trial::NCT9' } }))
            .toBe('sciweon::trial::NCT9');
    });

    it('orphan: no subject key -> deterministic orphan key from id (never null)', () => {
        expect(negKeyOf({ id: 'sciweon::neg::retraction::10.1/abc', subject: {} }))
            .toBe('sciweon::neg::orphan::sciweon::neg::retraction::10.1/abc');
    });

    it('orphan with missing id still returns a string (never null)', () => {
        const k = negKeyOf({});
        expect(typeof k).toBe('string');
        expect(k).toBe('sciweon::neg::orphan::');
    });

    it('accepts top-level compound_id as a defensive fallback', () => {
        expect(negKeyOf({ compound_id: 'sciweon::compound::CID:5' })).toBe('sciweon::compound::CID:5');
    });
});
