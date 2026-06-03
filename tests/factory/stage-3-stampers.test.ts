// @ts-nocheck
/**
 * PR-UMLS-3: stage-3 SID stamping cascade SSoT guard (extracted from stage-3-aggregate.js).
 * Locks the 10th stamper entry (snomed_concept) and the post-stamp UMLS phase order so the
 * SNOMED public projection runs BEFORE the SNOMED cross-link enricher and AFTER the stamper.
 */

import { describe, it, expect } from 'vitest';
import {
    SID_STAMPERS, POST_STAMP_UMLS_PHASES, runSidStampingCascade,
} from '../../scripts/factory/lib/stage-3-stampers.js';

describe('SID_STAMPERS cascade', () => {
    it('is a frozen array; the 10th entry is snomed, the 11th is the loinc_concept stamper', () => {
        expect(Object.isFrozen(SID_STAMPERS)).toBe(true);
        const scripts = SID_STAMPERS.map(s => s[1]);
        expect(scripts).toContain('stage-3-mesh-sid-stamp.js');
        expect(scripts).toContain('stage-3-snomed-sid-stamp.js');
        expect(scripts).toContain('stage-3-loinc-sid-stamp.js');
        // snomed stamps AFTER mesh; loinc stamps AFTER snomed (PR-UMLS-4 11th entry).
        expect(scripts.indexOf('stage-3-snomed-sid-stamp.js')).toBeGreaterThan(scripts.indexOf('stage-3-mesh-sid-stamp.js'));
        expect(scripts.indexOf('stage-3-loinc-sid-stamp.js')).toBeGreaterThan(scripts.indexOf('stage-3-snomed-sid-stamp.js'));
    });
});

describe('POST_STAMP_UMLS_PHASES order', () => {
    it('all public projections run BEFORE the cross-link enrichers (PR-UMLS-4b adds loinc-crosslink-enricher last)', () => {
        const scripts = POST_STAMP_UMLS_PHASES.map(p => p[1]);
        expect(scripts).toEqual([
            'mesh-public-builder.js',
            'snomed-public-builder.js',
            'loinc-public-builder.js',
            'mesh-crosslink-enricher.js',
            'snomed-crosslink-enricher.js',
            'loinc-crosslink-enricher.js',
        ]);
        // the public builders (which read the FULL cui-bearing files) run before the
        // cross-link enrichers, both AFTER the stampers seeded sid_s/sid_c.
        expect(scripts.indexOf('mesh-public-builder.js')).toBeLessThan(scripts.indexOf('mesh-crosslink-enricher.js'));
        expect(scripts.indexOf('snomed-public-builder.js')).toBeLessThan(scripts.indexOf('snomed-crosslink-enricher.js'));
        expect(scripts.indexOf('loinc-public-builder.js')).toBeLessThan(scripts.indexOf('mesh-crosslink-enricher.js'));
        // PR-UMLS-4b: the loinc crosslink enricher NOW exists and runs AFTER loinc-public-builder.
        expect(scripts).toContain('loinc-crosslink-enricher.js');
        expect(scripts.indexOf('loinc-public-builder.js')).toBeLessThan(scripts.indexOf('loinc-crosslink-enricher.js'));
    });
});

describe('runSidStampingCascade', () => {
    it('runs every stamper then every post-stamp phase, in order, all awaited', async () => {
        const calls = [];
        await runSidStampingCascade(async (name) => { calls.push(name); });
        const expected = [...SID_STAMPERS.map(s => s[1]), ...POST_STAMP_UMLS_PHASES.map(p => p[1])];
        expect(calls).toEqual(expected);
        // snomed stamper runs before the public projection runs before the snomed cross-link.
        expect(calls.indexOf('stage-3-snomed-sid-stamp.js')).toBeLessThan(calls.indexOf('snomed-public-builder.js'));
        expect(calls.indexOf('snomed-public-builder.js')).toBeLessThan(calls.indexOf('snomed-crosslink-enricher.js'));
    });

    it('propagates a stamper failure (hard-fail, no swallow)', async () => {
        await expect(runSidStampingCascade(async (name) => {
            if (name === 'stage-3-snomed-sid-stamp.js') throw new Error('boom');
        })).rejects.toThrow('boom');
    });
});
