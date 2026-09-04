/**
 * Lane 3S -- public claim containment, core filter behaviour.
 *
 * The oracles here are the PM-supplied constants in
 * `claim-containment-fixture.ts`. They are FIXED VALUES, never sums read back
 * from the implementation under test: an oracle derived from the code cannot
 * detect a fault in that code.
 */

import { describe, it, expect } from 'vitest';
import { applySourceRightsFilter } from '../../src/worker/lib/source-rights-filter';
import { claimContainmentLegacyMechanisms } from '../../src/worker/lib/claim-containment-legacy-test-only';
import {
    attackFixture, combinedSixSiteFixture, SENTINELS, FROZEN_CONTAINER_KEYS,
    EXPECTED_REMOVED_KEY_COUNT, EXPECTED_COMBINED_TALLY, CLAIM_MARKER_KEY, CLAIM_MARKER_STATE,
} from './claim-containment-fixture';

const WITHHELD = 'withheld_by_rights_policy';

describe('D-4.1 -- the six tally-increment sites, one case each', () => {
    it('site :109 kegg_drug -> kegg 1, removed, correct marker', () => {
        const { filtered, withheld } = applySourceRightsFilter({ kegg_drug: { control: 'D-CONTROL-1' } });
        expect((filtered as any).kegg_drug).toBeUndefined();
        expect((filtered as any).kegg_drug_visibility).toEqual(
            { source_visibility_state: WITHHELD, source_family: 'kegg', withheld_item_count: 1 });
        expect(withheld).toEqual({ meddra: 0, kegg: 1 });
    });
    it('site :112 kegg_drug_id -> kegg 1, removed, correct marker', () => {
        const { filtered, withheld } = applySourceRightsFilter({ kegg_drug_id: 'D-CONTROL-2' });
        expect((filtered as any).kegg_drug_id).toBeUndefined();
        expect((filtered as any).kegg_drug_id_visibility).toBe(WITHHELD);
        expect(withheld).toEqual({ meddra: 0, kegg: 1 });
    });
    it('site :118 faers_top_adr_terms -> meddra equals the array length', () => {
        const { filtered, withheld } = applySourceRightsFilter(
            { faers_top_adr_terms: ['PT-CONTROL-1', 'PT-CONTROL-2', 'PT-CONTROL-3'] });
        expect((filtered as any).faers_top_adr_terms).toBeUndefined();
        expect((filtered as any).faers_top_adr_terms_visibility.withheld_item_count).toBe(3);
        expect(withheld).toEqual({ meddra: 3, kegg: 0 });
    });
    it('site :121 meddra_pt -> meddra 1, removed', () => {
        const { filtered, withheld } = applySourceRightsFilter({ meddra_pt: 'PT-CONTROL-4' });
        expect((filtered as any).meddra_pt).toBeUndefined();
        expect((filtered as any).meddra_pt_visibility).toBe(WITHHELD);
        expect(withheld).toEqual({ meddra: 1, kegg: 0 });
    });
    it('site :142 id-list pruning -> restricted removed, controls preserved, count exact', () => {
        const { filtered, withheld } = applySourceRightsFilter({
            negative_evidence_ids: ['sciweon::neg::faers::control-1',
                'sciweon::neg::faers::control-2', 'sciweon::neg::other::keep'],
        });
        expect((filtered as any).negative_evidence_ids).toEqual(['sciweon::neg::other::keep']);
        expect((filtered as any).negative_evidence_ids_visibility.withheld_item_count).toBe(2);
        expect(withheld).toEqual({ meddra: 2, kegg: 0 });
    });
    it('site :153 full FAERS signal -> restricted content removed, counted ONCE', () => {
        const { filtered, withheld } = applySourceRightsFilter({ full_signal: combinedSixSiteFixture().full_signal });
        const s = (filtered as any).full_signal;
        expect(s.id).toBeUndefined();
        expect(s.detail.meddra_pt).toBeUndefined();
        expect(s.detail.meddra_pt_visibility).toBe(WITHHELD);
        expect(s.subject.kind).toBe('control'); // non-MedDRA content preserved
        expect(withheld).toEqual({ meddra: 1, kegg: 0 });
    });
});

describe('D-4.2 -- cross-site composition against the FROZEN constant', () => {
    it('the combined fixture yields exactly { meddra: 7, kegg: 2 }', () => {
        const { withheld } = applySourceRightsFilter(combinedSixSiteFixture());
        // FIXED ORACLE. withholdFaersSignal deletes full_signal.detail.meddra_pt
        // BEFORE recursion reaches `detail`, so the :121 rule does not fire a
        // second time. Recursion-before-withholding would yield { 8, 2 } here.
        expect(withheld).toEqual(EXPECTED_COMBINED_TALLY);
    });
    it('is stable when repeated and interleaved with another payload', () => {
        const first = applySourceRightsFilter(combinedSixSiteFixture()).withheld;
        applySourceRightsFilter(attackFixture());
        applySourceRightsFilter({ meddra_pt: 'PT-CONTROL-4' });
        const second = applySourceRightsFilter(combinedSixSiteFixture()).withheld;
        expect(first).toEqual(EXPECTED_COMBINED_TALLY);
        expect(second).toEqual(EXPECTED_COMBINED_TALLY); // no cross-call state
    });
});

describe('the six frozen containers -- removal', () => {
    for (const key of FROZEN_CONTAINER_KEYS) {
        it('removes ' + key + ' independently and counts it once', () => {
            const { filtered, withheld } = applySourceRightsFilter({ [key]: { inner: 1 } });
            expect((filtered as any)[key]).toBeUndefined();
            expect((filtered as any)[CLAIM_MARKER_KEY].removed_key_count).toBe(1);
            expect(withheld).toEqual({ meddra: 0, kegg: 0 }); // never a family tally
        });
    }
    it('removes all six together and at every depth', () => {
        const { filtered } = applySourceRightsFilter(attackFixture());
        const json = JSON.stringify(filtered);
        for (const key of FROZEN_CONTAINER_KEYS) expect(json).not.toContain(key);
        expect((filtered as any).compound.competing_claims).toBeUndefined();
        expect((filtered as any).related[0].competing_claims).toBeUndefined();
    });
    it('does NOT descend into a deleted container (E-2): N is 8, not 9', () => {
        // claim_overflow_counts itself contains a competing_claims key.
        // Deleting the outer key ends inspection of that subtree.
        const { filtered } = applySourceRightsFilter(attackFixture());
        expect((filtered as any)[CLAIM_MARKER_KEY].removed_key_count).toBe(EXPECTED_REMOVED_KEY_COUNT);
    });
});

describe('the forged marker -- L3S-2, recursively at every depth', () => {
    it('discards a forged marker at root, in a sub-object and in an array element', () => {
        const { filtered } = applySourceRightsFilter(attackFixture());
        expect((filtered as any).compound[CLAIM_MARKER_KEY]).toBeUndefined();
        expect((filtered as any).related[0][CLAIM_MARKER_KEY]).toBeUndefined();
        expect(JSON.stringify(filtered)).not.toContain('999'); // the forged count
        expect((filtered as any)[CLAIM_MARKER_KEY]).toEqual(
            { state: CLAIM_MARKER_STATE, removed_key_count: EXPECTED_REMOVED_KEY_COUNT });
    });
    it('the forged marker is NOT counted toward removed_key_count', () => {
        const { filtered } = applySourceRightsFilter(
            { [CLAIM_MARKER_KEY]: { state: 'x', removed_key_count: 999 } });
        expect((filtered as any)[CLAIM_MARKER_KEY]).toBeUndefined(); // N = 0 -> no marker
    });
});

describe('marker correctness -- E-2 / L3S-3', () => {
    it('exactly ONE marker, at the business root, never per record', () => {
        const { filtered } = applySourceRightsFilter(attackFixture());
        const hits = JSON.stringify(filtered).split(CLAIM_MARKER_KEY).length - 1;
        expect(hits).toBe(1);
        expect((filtered as any)[CLAIM_MARKER_KEY].state).toBe(CLAIM_MARKER_STATE);
    });
    it('carries no source_family and no value/path/source/overflow detail', () => {
        const { filtered } = applySourceRightsFilter(attackFixture());
        const marker = (filtered as any)[CLAIM_MARKER_KEY];
        expect(Object.keys(marker).sort()).toEqual(['removed_key_count', 'state']);
        const json = JSON.stringify(filtered);
        for (const s of SENTINELS) expect(json).not.toContain(s);
        expect(json).not.toContain('D00109');
        expect(json).not.toContain('D00110');
        expect(json).not.toContain('CLAIM_SET_INCOMPLETE_OVERFLOW');
    });
    it('N = 0 yields NO marker at all', () => {
        const open = { id: 'sciweon::compound::CID:1983', compound: { pubchem_cid: 1983 } };
        const { filtered, withheld } = applySourceRightsFilter(open);
        expect(filtered).toEqual(open);
        expect((filtered as any)[CLAIM_MARKER_KEY]).toBeUndefined();
        expect(withheld).toEqual({ meddra: 0, kegg: 0 });
    });
    it('WithheldTally keeps exactly two counters -- no third', () => {
        const { withheld } = applySourceRightsFilter(attackFixture());
        expect(Object.keys(withheld).sort()).toEqual(['kegg', 'meddra']);
    });
});

describe('ordering -- removal runs BEFORE the FAERS/KEGG mechanisms', () => {
    it('claim 3 does NOT increment the KEGG tally and attaches no source_visibility', () => {
        const { filtered, withheld } = applySourceRightsFilter(attackFixture());
        expect(withheld).toEqual({ meddra: 0, kegg: 0 }); // no phantom marker
        expect((filtered as any).source_visibility).toBeUndefined();
    });
    it('does not mutate the caller input object', () => {
        const input = attackFixture();
        applySourceRightsFilter(input);
        expect(input.competing_claims).toHaveLength(3);
        expect(input.claim_metadata_visibility.removed_key_count).toBe(999);
        expect(input.compound.competing_claims).toHaveLength(1);
    });
});

describe('6b -- the PM-supplied LEGACY baseline, observed not paraphrased', () => {
    // The legacy walk's isFaersSignal gate is NOT exported (D-1 pins that
    // function to the frozen substitution only), so this walker calls
    // withholdFaersSignal on every plain object. That is a STRICT SUPERSET of
    // the legacy path; a pass is therefore conservative. tally.meddra === 0
    // below proves the superset never fired on this fixture.
    const { withholdFaersSignal, withholdObjectKeys, pruneIdListArrays } = claimContainmentLegacyMechanisms;
    function isPlain(v: unknown): v is Record<string, unknown> {
        return typeof v === 'object' && v !== null && !Array.isArray(v);
    }
    function legacyWalk(node: unknown, tally: { meddra: number; kegg: number }): void {
        if (Array.isArray(node)) { for (const el of node) legacyWalk(el, tally); return; }
        if (!isPlain(node)) return;
        if (withholdFaersSignal(node)) tally.meddra += 1;
        withholdObjectKeys(node, tally);
        pruneIdListArrays(node, tally);
        for (const k of Object.keys(node)) legacyWalk(node[k], tally);
    }
    it('claims 1 and 2 survive; claim 3 loses its inner kegg_drug_id; containers survive', () => {
        const payload = attackFixture();
        const tally = { meddra: 0, kegg: 0 };
        legacyWalk(payload, tally);
        const claims = payload.competing_claims as any[];
        expect(claims[0]).toEqual({
            path: 'external_ids.kegg_drug_id', value: 'D00109', side: 'previous',
            source: { source: null, status: 'unknown' },
        });
        expect(claims[1].value).toBe('SENTINEL-MEDDRA-TERM-XYZZY');
        expect(claims[2].value.kegg_drug_id).toBeUndefined();
        expect(claims[2].value.kegg_drug_id_visibility).toBe(WITHHELD);
        expect(payload.claim_metadata_visibility.removed_key_count).toBe(999); // forgery survives
        for (const key of FROZEN_CONTAINER_KEYS) expect(key in payload).toBe(true);
        // Sixth row (L3S-4): kegg 1 is what fires the root source_visibility
        // marker at source-rights-filter.ts:171-176 (base numbering). meddra 0
        // proves the superset walker above changed nothing on this fixture.
        expect(tally).toEqual({ meddra: 0, kegg: 1 });
    });
});

describe('recorded consequence -- NOT a defect to fix', () => {
    it('is idempotent over a CONTAINER-FREE payload (the existing guarantee)', () => {
        const once = applySourceRightsFilter(combinedSixSiteFixture()).filtered;
        expect(applySourceRightsFilter(once).filtered).toEqual(once);
    });
    it('is NOT idempotent over its OWN container-bearing output, by design', () => {
        // A second pass sees the truthful marker as an input copy and discards
        // it (N = 0 -> no marker). Production applies the filter exactly once
        // per response. Preserving an input marker would re-admit forgery.
        const once = applySourceRightsFilter(attackFixture()).filtered;
        expect((once as any)[CLAIM_MARKER_KEY].removed_key_count).toBe(EXPECTED_REMOVED_KEY_COUNT);
        expect((applySourceRightsFilter(once).filtered as any)[CLAIM_MARKER_KEY]).toBeUndefined();
    });
});
