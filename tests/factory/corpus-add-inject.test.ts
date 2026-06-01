// @ts-nocheck
/**
 * PR-MD-2c: injectUniiAndAccount (the pure core of the first corpus mutation).
 * Locks Collar A (u injected on each seed survivor) + Collar B (added_n vs
 * resolvable_n; harvester-dropped CIDs land in missing_cids, never silently lost).
 */

import { describe, it, expect } from 'vitest';
import { injectUniiAndAccount } from '../../scripts/factory/lib/corpus-add-inject.js';

const rec = (cid, external_ids = undefined) => ({ id: `sciweon::compound::CID:${cid}`, pubchem_cid: cid, external_ids });
const seed = (pairs) => new Map(pairs.map(([c, u]) => [String(c), u]));

describe('injectUniiAndAccount', () => {
    it('injects external_ids.unii = target u on each seed survivor (+ provenance source)', () => {
        const records = [rec(100), rec(200)];
        const r = injectUniiAndAccount(records, seed([[100, 'UA'], [200, 'UB']]));
        expect(records[0].external_ids.unii).toBe('UA');
        expect(records[1].external_ids.unii).toBe('UB');
        expect(records[0].external_ids.sources).toContain('corpus_add_seed');
        expect(r).toMatchObject({ added_n: 2, resolvable_n: 2, missing_cids: [] });
    });

    it('Collar B: a resolvable CID absent from the baseline (harvester-dropped) -> missing_cids, not lost', () => {
        const records = [rec(100)];  // CID 200 was dropped by the harvester (macromolecule/no-record)
        const r = injectUniiAndAccount(records, seed([[100, 'UA'], [200, 'UB']]));
        expect(r.added_n).toBe(1);            // dm_linked reconciles to this, NOT 2
        expect(r.resolvable_n).toBe(2);
        expect(r.missing_cids).toEqual(['200']);
    });

    it('preserves an existing external_ids object + sets u authoritatively', () => {
        const records = [rec(100, { drugbank_id: 'DB1', sources: ['unichem'] })];
        injectUniiAndAccount(records, seed([[100, 'UA']]));
        expect(records[0].external_ids).toMatchObject({ drugbank_id: 'DB1', unii: 'UA' });
        expect(records[0].external_ids.sources).toEqual(expect.arrayContaining(['unichem', 'corpus_add_seed']));
    });

    it('ignores records without a matching seed cid; never throws on bad input', () => {
        const records = [rec(999), { id: 'x' }, null];
        const r = injectUniiAndAccount(records, seed([[100, 'UA']]));
        expect(r.added_n).toBe(0);
        expect(r.missing_cids).toEqual(['100']);
        expect(injectUniiAndAccount(null, null)).toEqual({ added_n: 0, resolvable_n: 0, missing_cids: [] });
    });
});
