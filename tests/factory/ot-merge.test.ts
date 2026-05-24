// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    mergeOtIntoCompound, buildOtIndex, mergeOtAcrossCompounds,
} from '../../scripts/factory/lib/ot-merge.js';

const OT_LICENSE = {
    upstream_source: 'open_targets',
    upstream_license: 'cc0-1.0',
    upstream_release: '26.03',
    ingestion_date: '2026-05-24',
};

function makeOtRecord(chemblId, overrides = {}) {
    return {
        id: `sciweon::ot-drug::${chemblId}`,
        chembl_id: chemblId,
        known_drug_info: {
            chembl_id: chemblId,
            name: 'aspirin', drug_type: 'Small molecule',
            mechanisms: [{ action_type: 'INHIBITOR', target_name: 'PTGS1' }],
            warnings: [], indications: [],
        },
        target_associations: [
            { target_id: 'ENSG00000095303', source: 'open_targets_clinical' },
        ],
        cross_references: [],
        license_metadata: OT_LICENSE,
        ...overrides,
    };
}

function makeCompound(chemblId, overrides = {}) {
    return {
        id: `sciweon::compound::CID:2244`,
        pubchem_cid: 2244,
        chembl_id: chemblId,
        ...overrides,
    };
}

describe('mergeOtIntoCompound (PR-OT-4)', () => {
    it('populates known_drug_info on chembl_id match', () => {
        const c = makeCompound('CHEMBL25');
        const ot = makeOtRecord('CHEMBL25');
        mergeOtIntoCompound(c, ot);
        expect(c.known_drug_info.name).toBe('aspirin');
        expect(c.known_drug_info.mechanisms).toHaveLength(1);
        expect(c.known_drug_info_license).toEqual(OT_LICENSE);
    });

    it('populates target_associations on chembl_id match', () => {
        const c = makeCompound('CHEMBL25');
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        expect(c.target_associations).toEqual([
            { target_id: 'ENSG00000095303', source: 'open_targets_clinical' },
        ]);
        expect(c.target_associations_license).toEqual(OT_LICENSE);
    });

    it('adds open_targets to provenance.sources with release + ingest date', () => {
        const c = makeCompound('CHEMBL25');
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        expect(c.provenance.sources).toEqual([
            { source: 'open_targets', source_id: 'CHEMBL25',
              ingested_at: '2026-05-24', release: '26.03' },
        ]);
    });

    it('no-op when chembl_id mismatches', () => {
        const c = makeCompound('CHEMBL_OTHER');
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        expect(c.known_drug_info).toBeUndefined();
        expect(c.target_associations).toBeUndefined();
        expect(c.provenance).toBeUndefined();
    });

    it('no-op when compound has no chembl_id', () => {
        const c = makeCompound(null);
        delete c.chembl_id;
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        expect(c.known_drug_info).toBeUndefined();
    });

    it('idempotent: re-running produces byte-identical output (target_associations)', () => {
        const c = makeCompound('CHEMBL25');
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        const after1 = JSON.stringify(c);
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        const after2 = JSON.stringify(c);
        expect(after1).toBe(after2);
        expect(c.target_associations).toHaveLength(1); // not duplicated
    });

    it('idempotent: provenance.sources never duplicates open_targets entry', () => {
        const c = makeCompound('CHEMBL25');
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        const otEntries = c.provenance.sources.filter(s => s.source === 'open_targets');
        expect(otEntries).toHaveLength(1);
    });

    it('preserves existing target_associations from other sources (additive)', () => {
        const c = makeCompound('CHEMBL25', {
            target_associations: [
                { target_id: 'ENSG_UNIPROT_DIRECT', source: 'uniprot_direct' },
            ],
        });
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        expect(c.target_associations).toHaveLength(2);
        expect(c.target_associations.find(t => t.source === 'uniprot_direct')).toBeTruthy();
        expect(c.target_associations.find(t => t.source === 'open_targets_clinical')).toBeTruthy();
    });

    it('replaces stale open_targets_clinical target_associations on re-merge', () => {
        const c = makeCompound('CHEMBL25', {
            target_associations: [
                { target_id: 'ENSG_OLD', source: 'open_targets_clinical' },
            ],
        });
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        const otTargets = c.target_associations.filter(t => t.source === 'open_targets_clinical');
        expect(otTargets.map(t => t.target_id)).toEqual(['ENSG00000095303']);
        expect(otTargets.find(t => t.target_id === 'ENSG_OLD')).toBeFalsy();
    });

    it('preserves existing provenance.sources from other adapters', () => {
        const c = makeCompound('CHEMBL25', {
            provenance: {
                sources: [{ source: 'pubchem', source_id: 'CID:2244' }],
            },
        });
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25'));
        expect(c.provenance.sources).toHaveLength(2);
        expect(c.provenance.sources.find(s => s.source === 'pubchem')).toBeTruthy();
    });

    it('updates existing open_targets provenance.sources entry on re-merge (single entry, latest release)', () => {
        const c = makeCompound('CHEMBL25');
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25', {
            license_metadata: { ...OT_LICENSE, upstream_release: '25.03', ingestion_date: '2025-12-01' },
        }));
        mergeOtIntoCompound(c, makeOtRecord('CHEMBL25', {
            license_metadata: { ...OT_LICENSE, upstream_release: '26.03', ingestion_date: '2026-05-24' },
        }));
        const otEntries = c.provenance.sources.filter(s => s.source === 'open_targets');
        expect(otEntries).toHaveLength(1);
        expect(otEntries[0].release).toBe('26.03');
        expect(otEntries[0].ingested_at).toBe('2026-05-24');
    });

    it('returns compound unchanged on null inputs', () => {
        expect(mergeOtIntoCompound(null, makeOtRecord('CHEMBL25'))).toBeNull();
        const c = makeCompound('CHEMBL25');
        expect(mergeOtIntoCompound(c, null)).toBe(c);
        expect(c.known_drug_info).toBeUndefined();
    });
});

describe('buildOtIndex (PR-OT-4)', () => {
    it('indexes OT records by chembl_id', () => {
        const { index, skipped } = buildOtIndex([
            makeOtRecord('CHEMBL1'), makeOtRecord('CHEMBL2'), makeOtRecord('CHEMBL3'),
        ]);
        expect(index.size).toBe(3);
        expect(index.get('CHEMBL1').chembl_id).toBe('CHEMBL1');
        expect(skipped).toBe(0);
    });

    it('skips records with missing/empty chembl_id', () => {
        const { index, skipped } = buildOtIndex([
            makeOtRecord('CHEMBL1'),
            { chembl_id: null },
            { chembl_id: '' },
            { id: 'no-chembl' },
            null,
        ]);
        expect(index.size).toBe(1);
        expect(skipped).toBe(4);
    });
});

describe('mergeOtAcrossCompounds (PR-OT-4)', () => {
    it('returns counters: matched / chembl_id-present / total', () => {
        const compounds = [
            makeCompound('CHEMBL25'),       // matches
            makeCompound('CHEMBL_OTHER'),   // chembl_id present, no OT match
            { id: 'no-chembl' },            // no chembl_id
        ];
        const { index: otIndex } = buildOtIndex([makeOtRecord('CHEMBL25')]);
        const stats = mergeOtAcrossCompounds(compounds, otIndex);
        expect(stats).toEqual({ matched: 1, chemblIdPresent: 2, totalCompounds: 3 });
    });

    it('mutates compounds in place (matched ones get known_drug_info populated)', () => {
        const compounds = [makeCompound('CHEMBL25'), makeCompound('CHEMBL999')];
        const { index: otIndex } = buildOtIndex([makeOtRecord('CHEMBL25')]);
        mergeOtAcrossCompounds(compounds, otIndex);
        expect(compounds[0].known_drug_info?.name).toBe('aspirin');
        expect(compounds[1].known_drug_info).toBeUndefined();
    });
});
