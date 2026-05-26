// @ts-nocheck
/**
 * Tests for PR-CORE-MERGE-LEAK deep-merge strategy in aggregated-merger.
 *
 * Defends against the destructive "current wins" equilibrium that held
 * unichem fully_enriched at 32286 forever despite F2 cycles adding ~873
 * UNII records each cycle. The deepMergeCompound strategy preserves
 * prev's non-null fields when current is null, lets sources array union,
 * and protects F3-stage-only fields (OT known_drug_info, SID stamps)
 * that current (a pre-F3 F2 output) cannot carry.
 */

import { describe, it, expect } from 'vitest';
import {
    deepMergeCompound, makeDeepMergeCounters,
    F3_PRESERVE_FIELDS, STRUCTURAL_PRESERVE_FIELDS,
} from '../../scripts/factory/lib/aggregated-deep-merge.js';
import { mergeRecords } from '../../scripts/factory/lib/aggregated-merger.js';

function makePrev(extra = {}) {
    return {
        id: 'sciweon::compound::CID:105001',
        pubchem_cid: 105001,
        inchi_key: 'STUB-A',
        smiles_canonical: 'CCO',
        external_ids: { unii: '8MJB9HSC8Q', chebi_id: 'CHEBI:1', sources: ['unichem'] },
        known_drug_info: { name: 'Aspirin', max_phase: 4 },
        sid_s: 'abc123',
        sid_c: 'xyz789',
        ...extra,
    };
}

function makeCurrent(extra = {}) {
    // F2 baseline-derived: pubchem provenance + unichem source stamp added,
    // but UniChem returned null this cycle (UNII not gained). No F3 fields.
    return {
        id: 'sciweon::compound::CID:105001',
        pubchem_cid: 105001,
        inchi_key: 'STUB-A',
        smiles_canonical: 'CCO',
        external_ids: { unii: null, sources: ['unichem'] },
        ...extra,
    };
}

describe('deepMergeCompound -- UNII regression defense', () => {
    it('preserves prev UNII when current has unii=null (the production root cause)', () => {
        const merged = deepMergeCompound(makePrev(), makeCurrent());
        expect(merged.external_ids.unii).toBe('8MJB9HSC8Q');
    });

    it('preserves prev UNII when current omits unii field entirely', () => {
        const prev = makePrev();
        const current = { id: prev.id, external_ids: { sources: ['unichem'] } };
        const merged = deepMergeCompound(prev, current);
        expect(merged.external_ids.unii).toBe('8MJB9HSC8Q');
    });

    it('current non-null unii wins over prev unii (normal monotonic growth)', () => {
        const prev = makePrev();
        const current = makeCurrent({ external_ids: { unii: 'NEWUNII123', sources: ['unichem'] } });
        const merged = deepMergeCompound(prev, current);
        expect(merged.external_ids.unii).toBe('NEWUNII123');
    });
});

describe('deepMergeCompound -- sources array union', () => {
    it('unions prev and current sources arrays without dupes', () => {
        const prev = makePrev({ external_ids: { unii: 'X', sources: ['unichem', 'rxnorm'] } });
        const current = makeCurrent({ external_ids: { unii: null, sources: ['unichem', 'faers'] } });
        const merged = deepMergeCompound(prev, current);
        expect(new Set(merged.external_ids.sources)).toEqual(new Set(['unichem', 'rxnorm', 'faers']));
        expect(merged.external_ids.sources.length).toBe(3);
    });

    it('handles missing prev sources gracefully', () => {
        const prev = { id: 'x', external_ids: { unii: 'X' } };
        const current = { id: 'x', external_ids: { sources: ['unichem'] } };
        const merged = deepMergeCompound(prev, current);
        expect(merged.external_ids.sources).toEqual(['unichem']);
    });
});

describe('deepMergeCompound -- F3-stage-only field preservation', () => {
    it('preserves prev known_drug_info when current is missing it', () => {
        const merged = deepMergeCompound(makePrev(), makeCurrent());
        expect(merged.known_drug_info).toEqual({ name: 'Aspirin', max_phase: 4 });
    });

    it('preserves prev sid_s + sid_c when current is missing them', () => {
        const merged = deepMergeCompound(makePrev(), makeCurrent());
        expect(merged.sid_s).toBe('abc123');
        expect(merged.sid_c).toBe('xyz789');
    });

    it('current non-null F3 field wins (re-stamp scenarios)', () => {
        const prev = makePrev();
        const current = makeCurrent({ sid_s: 'newabc', sid_c: 'newxyz' });
        const merged = deepMergeCompound(prev, current);
        expect(merged.sid_s).toBe('newabc');
        expect(merged.sid_c).toBe('newxyz');
    });

    it('full F3_PRESERVE_FIELDS list is preserved when current missing all', () => {
        const prev = {
            id: 'x',
            known_drug_info: { a: 1 },
            known_drug_info_license: 'cc0',
            target_associations: [{ t: 1 }],
            target_associations_license: 'cc0',
            sid_s: 's1', sid_c: 'c1',
        };
        const current = { id: 'x' };
        const merged = deepMergeCompound(prev, current);
        for (const f of F3_PRESERVE_FIELDS) {
            expect(merged[f]).toEqual(prev[f]);
        }
    });
});

describe('deepMergeCompound -- structural field defense', () => {
    it('preserves prev smiles/inchi when current has null/empty (upstream parser bug defense)', () => {
        const prev = makePrev({ inchi: 'InChI=1S/X', smiles: 'CC' });
        const current = makeCurrent({ inchi: null, smiles: '', smiles_canonical: null, inchi_key: null });
        const merged = deepMergeCompound(prev, current);
        expect(merged.inchi).toBe('InChI=1S/X');
        expect(merged.smiles).toBe('CC');
        expect(merged.smiles_canonical).toBe('CCO');
        expect(merged.inchi_key).toBe('STUB-A');
    });

    it('full STRUCTURAL_PRESERVE_FIELDS list covered', () => {
        expect(STRUCTURAL_PRESERVE_FIELDS).toContain('smiles');
        expect(STRUCTURAL_PRESERVE_FIELDS).toContain('smiles_canonical');
        expect(STRUCTURAL_PRESERVE_FIELDS).toContain('inchi');
        expect(STRUCTURAL_PRESERVE_FIELDS).toContain('inchi_key');
    });
});

describe('deepMergeCompound -- top-level scalar policy', () => {
    it('current scalar wins for non-F3 non-structural fields', () => {
        const prev = makePrev({ iupac_name: 'old-name' });
        const current = makeCurrent({ iupac_name: 'new-name' });
        const merged = deepMergeCompound(prev, current);
        expect(merged.iupac_name).toBe('new-name');
    });

    it('new external_ids field added by current preserved', () => {
        const prev = { id: 'x', external_ids: { unii: 'X' } };
        const current = { id: 'x', external_ids: { drugbank_id: 'DB1', sources: ['unichem', 'drugbank'] } };
        const merged = deepMergeCompound(prev, current);
        expect(merged.external_ids.unii).toBe('X');
        expect(merged.external_ids.drugbank_id).toBe('DB1');
    });
});

describe('deepMergeCompound -- idempotency', () => {
    it('merging a record with itself produces equivalent state (no field churn)', () => {
        const r = makePrev();
        const once = deepMergeCompound(r, r);
        const twice = deepMergeCompound(once, once);
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    });
});

describe('deepMergeCompound -- counters telemetry', () => {
    it('counts preserved external_id fields + unioned sources', () => {
        const counters = makeDeepMergeCounters();
        // prev has rxnorm that current lacks; current has faers that prev lacks.
        // Union grows beyond max(prev.length, current.length) so unionedSources fires.
        const prev = makePrev({ external_ids: { unii: 'X', chebi_id: 'CHEBI:1', sources: ['unichem', 'rxnorm'] } });
        const current = makeCurrent({ external_ids: { unii: null, sources: ['unichem', 'faers'] } });
        deepMergeCompound(prev, current, counters);
        expect(counters.total).toBe(1);
        expect(counters.preservedExternalIdFields).toBeGreaterThanOrEqual(1);
        expect(counters.unionedSources).toBe(1);
        // preservedF3Fields counter fires only on explicit-null-override case;
        // F2 output normally omits F3 fields entirely (preserved via spread,
        // not via restore loop), so this counter stays 0 in normal ops.
    });

    it('preservedF3Fields counter fires when current explicitly nulls F3 field', () => {
        const counters = makeDeepMergeCounters();
        const prev = makePrev();  // has sid_s, sid_c, known_drug_info
        const current = makeCurrent({ sid_s: null, sid_c: null, known_drug_info: null });
        deepMergeCompound(prev, current, counters);
        expect(counters.preservedF3Fields).toBeGreaterThanOrEqual(3);
    });

    it('sample tracks first 10 CIDs that gained preserved fields', () => {
        const counters = makeDeepMergeCounters();
        for (let i = 0; i < 15; i++) {
            const prev = { id: `cid_${i}`, external_ids: { unii: 'X', sources: ['unichem'] } };
            const current = { id: `cid_${i}`, external_ids: { unii: null, sources: ['unichem'] } };
            deepMergeCompound(prev, current, counters);
        }
        expect(counters.sample.length).toBe(10);
        expect(counters.sample[0]).toBe('cid_0');
    });
});

describe('mergeRecords backward compat (non-compound files)', () => {
    it('strategy=null keeps whole-record replace for trials/papers/links', () => {
        const prev = [{ id: 't1', stub: 'old', extras: { a: 1 } }];
        const current = [{ id: 't1', stub: 'new' }];  // missing extras
        const { merged } = mergeRecords(current, prev, r => r.id, null);
        expect(merged[0].stub).toBe('new');
        expect(merged[0].extras).toBeUndefined();  // whole-record replace; extras lost
    });

    it('strategy=deepMergeCompound preserves prev fields for compounds-enriched.jsonl', () => {
        const prev = [makePrev()];
        const current = [makeCurrent()];
        const { merged, stats } = mergeRecords(current, prev, r => r.id, deepMergeCompound);
        expect(merged[0].external_ids.unii).toBe('8MJB9HSC8Q');  // preserved
        expect(merged[0].sid_s).toBe('abc123');  // preserved
        expect(stats.merged_deep_total).toBe(1);
    });
});
