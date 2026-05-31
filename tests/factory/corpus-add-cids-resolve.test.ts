// @ts-nocheck
/**
 * PR-MD-2b: pure UNII -> CID resolution + coverage (corpus-add-cids-resolve.js).
 * Locks the SRS-honest reason set {no_srs_inchikey, no_cid}, the resolvable-carries-
 * target-UNII contract (for 2c Collar A), and resolvable_n as an upper bound.
 */

import { describe, it, expect } from 'vitest';
import {
    invertSrsToUniiIndex, classifyUniiResolution, summarizeCoverage, buildAddCidsArtifact,
} from '../../scripts/factory/lib/corpus-add-cids-resolve.js';

describe('invertSrsToUniiIndex', () => {
    it('inverts InChIKey-keyed SRS map to UNII-keyed (total, lossless)', () => {
        const m = new Map([
            ['IKEY1', { unii: 'UA', preferred_name: 'Alpha' }],
            ['IKEY2', { unii: 'UB', preferred_name: 'Beta' }],
        ]);
        const idx = invertSrsToUniiIndex(m);
        expect(idx.get('UA')).toEqual({ inchi_key: 'IKEY1', name: 'Alpha' });
        expect(idx.get('UB')).toEqual({ inchi_key: 'IKEY2', name: 'Beta' });
    });
    it('non-map input -> empty index (never throws)', () => {
        expect(invertSrsToUniiIndex(null).size).toBe(0);
    });
});

describe('classifyUniiResolution', () => {
    it('no InChIKey -> no_srs_inchikey', () => {
        expect(classifyUniiResolution('UA', null, null)).toEqual({ unii: 'UA', reason: 'no_srs_inchikey' });
    });
    it('InChIKey but no CID -> no_cid', () => {
        expect(classifyUniiResolution('UA', 'IKEY1', null)).toEqual({ unii: 'UA', reason: 'no_cid', inchikey: 'IKEY1' });
    });
    it('InChIKey + CID -> resolvable carrying the TARGET unii (Collar A)', () => {
        expect(classifyUniiResolution('UA', 'IKEY1', 1234, 'Alpha'))
            .toEqual({ unii: 'UA', inchikey: 'IKEY1', cid: '1234', name: 'Alpha' });
    });
});

describe('summarizeCoverage + buildAddCidsArtifact', () => {
    const classified = [
        classifyUniiResolution('U1', 'I1', 11, 'A'),     // resolvable
        classifyUniiResolution('U2', 'I2', 22, 'B'),     // resolvable
        classifyUniiResolution('U3', null, null),        // no_srs_inchikey
        classifyUniiResolution('U4', 'I4', null),        // no_cid
    ];

    it('coverage sums: resolvable + unresolvable = target, by_reason split', () => {
        const c = summarizeCoverage(classified);
        expect(c).toEqual({
            target: 4, resolvable_n: 2, unresolvable_n: 2,
            by_reason: { no_srs_inchikey: 1, no_cid: 1 },
        });
    });

    it('artifact: resolvable list carries {unii,cid}; unresolvable carries reason; upper-bound note', () => {
        const a = buildAddCidsArtifact(classified);
        expect(a.resolvable).toHaveLength(2);
        expect(a.resolvable[0]).toMatchObject({ unii: 'U1', cid: '11' });
        expect(a.unresolvable).toEqual([{ unii: 'U3', reason: 'no_srs_inchikey' }, { unii: 'U4', reason: 'no_cid' }]);
        expect(a.note).toMatch(/UPPER BOUND/);
        expect(a.coverage.resolvable_n).toBe(2);
    });
});
