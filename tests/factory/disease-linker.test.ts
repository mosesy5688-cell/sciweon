// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    parseDiseaseIdNamespace, PRIMARY_NAMESPACE_MAP, CANON_VERSIONS,
    TAIL_FUSE_NAMESPACE, DISEASE_ID_PREFIX,
} from '../../src/lib/schemas/disease.js';
import {
    buildDiseaseRecord, dedupeBySciweonId, buildNamespaceCounts,
} from '../../scripts/factory/lib/disease-linker-helpers.js';

const NOW = '2026-05-25T10:00:00.000Z';

describe('PRIMARY_NAMESPACE_MAP — 5 first-class namespaces lock', () => {
    it('has exactly 5 entries (OBA / MONDO / EFO / HP / Orphanet)', () => {
        expect(Object.keys(PRIMARY_NAMESPACE_MAP).sort()).toEqual(['EFO', 'HP', 'MONDO', 'OBA', 'Orphanet']);
    });
    it('values are lowercased Sciweon namespace identifiers', () => {
        expect(PRIMARY_NAMESPACE_MAP.MONDO).toBe('mondo');
        expect(PRIMARY_NAMESPACE_MAP.Orphanet).toBe('orphanet');
    });
});

describe('CANON_VERSIONS — 6 canon tracks (5 primary + 1 tail-fuse)', () => {
    it('has 6 canon versions including tail-fuse', () => {
        expect(Object.keys(CANON_VERSIONS).sort()).toEqual(['efo', 'hp', 'mondo', 'oba', 'orphanet', 'unclassified_ontology']);
    });
    it('each canon version matches disease.<ns>.v1.0 format', () => {
        for (const [ns, ver] of Object.entries(CANON_VERSIONS)) {
            expect(ver).toBe(`disease.${ns}.v1.0`);
        }
    });
});

describe('parseDiseaseIdNamespace — primary routing', () => {
    it('MONDO_0000005 -> mondo + mondo:0000005', () => {
        const r = parseDiseaseIdNamespace('MONDO_0000005');
        expect(r.namespace).toBe('mondo');
        expect(r.numeric_id).toBe('0000005');
        expect(r.ontology_prefix).toBe('MONDO');
        expect(r.anchor_payload).toBe('mondo:0000005');
        expect(r.canonicalization_version).toBe('disease.mondo.v1.0');
        expect(r.sciweon_id).toBe(`${DISEASE_ID_PREFIX}mondo:0000005`);
    });
    it('EFO_0000094 -> efo (frozen reference pin source)', () => {
        const r = parseDiseaseIdNamespace('EFO_0000094');
        expect(r.namespace).toBe('efo');
        expect(r.anchor_payload).toBe('efo:0000094');
        expect(r.canonicalization_version).toBe('disease.efo.v1.0');
    });
    it('OBA_0000015 -> oba (largest namespace, 37.08% of corpus)', () => {
        expect(parseDiseaseIdNamespace('OBA_0000015').namespace).toBe('oba');
    });
    it('HP_0000002 -> hp', () => {
        expect(parseDiseaseIdNamespace('HP_0000002').namespace).toBe('hp');
    });
    it('Orphanet_100 -> orphanet (case-sensitive prefix match)', () => {
        const r = parseDiseaseIdNamespace('Orphanet_100');
        expect(r.namespace).toBe('orphanet');
        expect(r.anchor_payload).toBe('orphanet:100');
    });
});

describe('parseDiseaseIdNamespace — tail-fuse routing', () => {
    it('DOID_0050890 -> unclassified_ontology with FULL raw id in payload', () => {
        const r = parseDiseaseIdNamespace('DOID_0050890');
        expect(r.namespace).toBe(TAIL_FUSE_NAMESPACE);
        expect(r.ontology_prefix).toBe('DOID');
        expect(r.anchor_payload).toBe('unclassified_ontology:DOID_0050890');
        expect(r.canonicalization_version).toBe('disease.unclassified_ontology.v1.0');
    });
    it('NCIT_C117245 -> tail-fuse preserves NCIT_ prefix in payload', () => {
        const r = parseDiseaseIdNamespace('NCIT_C117245');
        expect(r.anchor_payload).toBe('unclassified_ontology:NCIT_C117245');
    });
    it('OTAR_0000003 -> tail-fuse', () => {
        expect(parseDiseaseIdNamespace('OTAR_0000003').namespace).toBe(TAIL_FUSE_NAMESPACE);
    });
    it('case-sensitive: mondo_0000001 (lowercase prefix) goes to tail-fuse', () => {
        const r = parseDiseaseIdNamespace('mondo_0000001');
        expect(r.namespace).toBe(TAIL_FUSE_NAMESPACE);
        expect(r.ontology_prefix).toBe('mondo');
    });
});

describe('parseDiseaseIdNamespace — invalid input', () => {
    it('null -> null', () => { expect(parseDiseaseIdNamespace(null)).toBeNull(); });
    it('empty string -> null', () => { expect(parseDiseaseIdNamespace('')).toBeNull(); });
    it('non-string -> null', () => { expect(parseDiseaseIdNamespace(42)).toBeNull(); });
    it('no underscore -> null', () => { expect(parseDiseaseIdNamespace('EFOXXX')).toBeNull(); });
    it('prefix with digits -> null', () => { expect(parseDiseaseIdNamespace('EFO2_001')).toBeNull(); });
    it('empty suffix -> null', () => { expect(parseDiseaseIdNamespace('EFO_')).toBeNull(); });
});

describe('buildDiseaseRecord — full enrichment', () => {
    const OT_ROW = {
        id: 'sciweon::ot-disease::MONDO_0000005',
        disease_id: 'MONDO_0000005',
        name: 'disease or disorder',
        description: 'A condition that impairs normal functioning.',
        synonyms: {
            has_exact_synonym: ['disease'],
            has_related_synonym: ['disorder'],
            has_broad_synonym: [],
            has_narrow_synonym: [],
        },
        therapeutic_areas: ['MONDO_0000001'],
        parents: [],
        ancestors: [],
        db_xrefs: ['DOID:4', 'NCIT:C2991'],
        code: 'http://purl.obolibrary.org/obo/MONDO_0000005',
        license_metadata: { upstream_source: 'open_targets', upstream_license: 'cc0-1.0' },
    };

    it('builds correct Sciweon record with multi-canon metadata', () => {
        const r = buildDiseaseRecord(OT_ROW, NOW);
        expect(r.skip).toBeUndefined();
        expect(r.record.id).toBe('sciweon::disease::mondo:0000005');
        expect(r.record.namespace).toBe('mondo');
        expect(r.record.anchor_payload).toBe('mondo:0000005');
        expect(r.record.canonicalization_version).toBe('disease.mondo.v1.0');
        expect(r.record.name).toBe('disease or disorder');
        expect(r.record.therapeutic_areas).toEqual(['MONDO_0000001']);
        expect(r.record.db_xrefs).toEqual(['DOID:4', 'NCIT:C2991']);
        expect(r.record.provenance.sources[0].source).toBe('open_targets');
        expect(r.record.provenance.sources[0].source_id).toBe('MONDO_0000005');
        expect(r.record.provenance.last_updated).toBe(NOW);
    });

    it('missing disease_id -> skip missing_disease_id', () => {
        expect(buildDiseaseRecord({}, NOW).skip).toBe('missing_disease_id');
    });
    it('unparseable disease_id -> skip unparseable_disease_id', () => {
        expect(buildDiseaseRecord({ disease_id: 'no-underscore-here' }, NOW).skip).toBe('unparseable_disease_id');
    });
    it('null row -> skip missing_disease_id', () => {
        expect(buildDiseaseRecord(null, NOW).skip).toBe('missing_disease_id');
    });
});

describe('dedupeBySciweonId', () => {
    it('preserves first-wins semantics', () => {
        const recs = [
            { id: 'sciweon::disease::efo:0000094', name: 'first' },
            { id: 'sciweon::disease::efo:0000094', name: 'second' },
            { id: 'sciweon::disease::mondo:0000005', name: 'third' },
        ];
        const r = dedupeBySciweonId(recs);
        expect(r.deduped).toHaveLength(2);
        expect(r.duplicates).toBe(1);
        expect(r.deduped[0].name).toBe('first');
    });
    it('tail-fuse + primary cannot collide (anchor_payload preserves namespace)', () => {
        const recs = [
            { id: 'sciweon::disease::mondo:0000005' },
            { id: 'sciweon::disease::unclassified_ontology:DOID_0050890' },
        ];
        expect(dedupeBySciweonId(recs).deduped).toHaveLength(2);
    });
});

describe('buildNamespaceCounts', () => {
    it('counts per namespace including 0s for empty buckets', () => {
        const recs = [
            { namespace: 'efo' }, { namespace: 'efo' }, { namespace: 'mondo' },
            { namespace: 'unclassified_ontology' },
        ];
        const c = buildNamespaceCounts(recs);
        expect(c.efo).toBe(2);
        expect(c.mondo).toBe(1);
        expect(c.oba).toBe(0);
        expect(c.unclassified_ontology).toBe(1);
    });
});
