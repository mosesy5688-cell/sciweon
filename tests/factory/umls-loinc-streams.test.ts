// @ts-nocheck
/**
 * PR-UMLS-4: LOINC (LNC) extensions to the shared umls-concept lib (network-free, synthetic
 * MRCONSO rows). Split out of umls-concept-streams.test.ts to keep both files under the Art 5.1
 * 250-line cap. Locks: the LNC harvest parameters, the LNC distinct-CODE measurement path (incl
 * the target-independent tally + no-shard ceiling boolean), and the buildLoincLicenseMetadata /
 * LOINC_ATTRIBUTION verbatim Regenstrief notice.
 */

import { describe, it, expect } from 'vitest';
import {
    MESH_SAB, LOINC_SAB, LOINC_CANONICALIZATION_VERSION, LOINC_ATTRIBUTION,
    buildLoincLicenseMetadata, newConceptAccumulator, ingestMrconsoRow, finalizeConcepts,
} from '../../scripts/factory/lib/umls-concept-streams.js';

function row(overrides = {}) {
    const base = {
        CUI: 'C0000001', LAT: 'ENG', TS: 'P', LUI: 'L1', STT: 'PF', SUI: 'S1', ISPREF: 'Y',
        AUI: 'A1', SAUI: '', SCUI: '', SDUI: '', SAB: 'LNC', TTY: 'LN', CODE: '34084-4',
        STR: 'Concept One', SRL: '0', SUPPRESS: 'N', CVF: '',
    };
    return { ...base, ...overrides };
}

function ingestAll(rows, target) {
    const acc = newConceptAccumulator();
    for (const r of rows) ingestMrconsoRow(acc, r, target);
    return acc;
}

describe('LOINC (LNC) harvest parameters + distinct-code measurement path', () => {
    it('LOINC_SAB === LNC, LOINC_CANONICALIZATION_VERSION === loinc.concept.v1.0', () => {
        expect(LOINC_SAB).toBe('LNC');
        expect(LOINC_CANONICALIZATION_VERSION).toBe('loinc.concept.v1.0');
    });

    it('harvesting target=LNC collapses LNC atoms -> concepts with LNC:<code> anchor; LNC counted', () => {
        const acc = ingestAll([
            row({ CODE: '34084-4', SAB: 'LNC', STR: 'PREFERRED LN', ISPREF: 'Y', TS: 'P', STT: 'PF', TTY: 'LN', SUI: 'A' }),
            row({ CODE: '34084-4', SAB: 'LNC', STR: 'syn lab', ISPREF: 'N', TS: 'S', STT: 'VO', SUI: 'B' }),
            row({ CODE: '2951-2', SAB: 'LNC', STR: 'Sodium', ISPREF: 'Y', TS: 'P', STT: 'PF', TTY: 'LN', SUI: 'C' }),
        ], LOINC_SAB);
        const fin = finalizeConcepts(acc, LOINC_SAB, LOINC_CANONICALIZATION_VERSION);
        expect(fin.concepts.map(c => c.code).sort()).toEqual(['2951-2', '34084-4']);
        const c0 = fin.concepts.find(c => c.code === '34084-4');
        expect(c0.preferred_str).toBe('PREFERRED LN');
        expect(c0.synonyms).toEqual(['syn lab']);
        expect(c0.anchor_payload).toBe('LNC:34084-4');
        expect(c0.canonicalization_version).toBe('loinc.concept.v1.0');
        expect(c0.sab).toBe('LNC');
        // distinct-LNC measurement (target-independent path): the LNC Set tallies both codes.
        expect(fin.distinctCodeBySab.LNC).toBe(2);
        // ceiling-check boolean: measured LNC distinct < 1e6 (no-shard precondition).
        expect(fin.distinctCodeBySab.LNC < 1e6).toBe(true);
    });

    it('LNC distinct-code is measured even when the harvest target is MSH (target-independent)', () => {
        const acc = ingestAll([
            row({ CODE: 'D9', SAB: 'MSH', STR: 'mesh' }),
            row({ CODE: '718-7', SAB: 'LNC', STR: 'Hemoglobin' }),
            row({ CODE: '2160-0', SAB: 'LNC', STR: 'Creatinine' }),
        ], MESH_SAB);
        const d = finalizeConcepts(acc, MESH_SAB).distinctCodeBySab;
        expect(d.LNC).toBe(2);   // measured regardless of MSH harvest target
        expect(d.MSH).toBe(1);
    });
});

describe('buildLoincLicenseMetadata + LOINC_ATTRIBUTION (verbatim Regenstrief notice)', () => {
    it('LOINC_ATTRIBUTION is the verbatim Regenstrief notice (Regenstrief + (R) + loinc.org/license)', () => {
        expect(typeof LOINC_ATTRIBUTION).toBe('string');
        expect(LOINC_ATTRIBUTION.length).toBeGreaterThan(0);
        expect(LOINC_ATTRIBUTION).toContain('Regenstrief Institute, Inc.');
        expect(LOINC_ATTRIBUTION).toContain('LOINC®');
        expect(LOINC_ATTRIBUTION).toContain('loinc.org/license');
        expect(LOINC_ATTRIBUTION).toContain('copyright © 1995-2026');
    });

    it('buildLoincLicenseMetadata carries a non-empty loinc_attribution containing "Regenstrief"', () => {
        const m = buildLoincLicenseMetadata('2026AA', '2026-06-03');
        expect(m.upstream_source).toBe('umls_metathesaurus');
        expect(m.upstream_release).toBe('2026AA');
        expect(m.ingestion_date).toBe('2026-06-03');
        expect(typeof m.loinc_attribution).toBe('string');
        expect(m.loinc_attribution.length).toBeGreaterThan(0);
        expect(m.loinc_attribution).toContain('Regenstrief');
        expect(m.loinc_attribution).toBe(LOINC_ATTRIBUTION);
    });
});
