// @ts-nocheck
/**
 * PR-UMLS-3: SNOMED CT US (SAB=SNOMEDCT_US) extract contract tests (network-free,
 * synthetic MRCONSO rows). NO real SNOMED strings -- synthetic placeholders only.
 *
 * Locks: the SAB-parameterized finalize emits SNOMEDCT_US concepts with the snomed anchor
 * fields; EXACT SAB matching (SNOMEDCT_VET / near-SABs must NOT leak into the SNOMED set);
 * and that the MeSH path (default finalize) is UNCHANGED (no regression).
 */

import { describe, it, expect } from 'vitest';
import {
    SNOMED_SAB, SNOMED_CANONICALIZATION_VERSION, MESH_SAB, MESH_CANONICALIZATION_VERSION,
    newConceptAccumulator, ingestMrconsoRow, finalizeConcepts,
} from '../../scripts/factory/lib/umls-concept-streams.js';

function row(overrides = {}) {
    const base = {
        CUI: 'C0000001', LAT: 'ENG', TS: 'P', LUI: 'L1', STT: 'PF', SUI: 'S1', ISPREF: 'Y',
        AUI: 'A1', SAUI: '', SCUI: '', SDUI: '', SAB: 'SNOMEDCT_US', TTY: 'PT', CODE: '73211009',
        STR: 'syn-placeholder', SRL: '0', SUPPRESS: 'N', CVF: '',
    };
    return { ...base, ...overrides };
}

function ingestSnomed(rows) {
    const acc = newConceptAccumulator();
    for (const r of rows) ingestMrconsoRow(acc, r, SNOMED_SAB);
    return finalizeConcepts(acc, SNOMED_SAB, SNOMED_CANONICALIZATION_VERSION);
}

describe('SNOMED constants', () => {
    it('SAB = SNOMEDCT_US, canon = snomed.concept.v1.0', () => {
        expect(SNOMED_SAB).toBe('SNOMEDCT_US');
        expect(SNOMED_CANONICALIZATION_VERSION).toBe('snomed.concept.v1.0');
    });
});

describe('SAB-parameterized SNOMED finalize -- anchor fields', () => {
    it('emits sab=SNOMEDCT_US, anchor_payload=SNOMEDCT_US:<code>, snomed canon, cui carried', () => {
        const fin = ingestSnomed([row({ CODE: '73211009', CUI: 'C0011849' })]);
        expect(fin.concepts).toHaveLength(1);
        const c = fin.concepts[0];
        expect(c.code).toBe('73211009');
        expect(c.sab).toBe('SNOMEDCT_US');
        expect(c.anchor_payload).toBe('SNOMEDCT_US:73211009');
        expect(c.canonicalization_version).toBe('snomed.concept.v1.0');
        expect(c.cui).toBe('C0011849'); // CUI carried internally (cross-link anchor, not identity)
    });
});

describe('EXACT SAB match -- near-SABs do NOT leak into the SNOMED set', () => {
    it('SNOMEDCT_VET / SNOMEDCT do NOT enter the SNOMEDCT_US harvest NOR its distinct-CODE Set', () => {
        const fin = ingestSnomed([
            row({ CODE: 'V1', SAB: 'SNOMEDCT_VET' }),
            row({ CODE: 'V2', SAB: 'SNOMEDCT' }),
            row({ CODE: '38341003', SAB: 'SNOMEDCT_US' }),
        ]);
        expect(fin.concepts.map(c => c.code)).toEqual(['38341003']); // only exact SNOMEDCT_US
        expect(fin.distinctCodeBySab.SNOMEDCT_US).toBe(1);           // near-SABs not counted
    });
});

describe('SUPPRESS / LAT filters apply to SNOMED too', () => {
    it('SUPPRESS != N and LAT != ENG are dropped', () => {
        const fin = ingestSnomed([
            row({ CODE: 'S1', SUPPRESS: 'O' }),
            row({ CODE: 'S2', LAT: 'FRE' }),
            row({ CODE: '22298006', SUPPRESS: 'N', LAT: 'ENG' }),
        ]);
        expect(fin.concepts.map(c => c.code)).toEqual(['22298006']);
    });
});

describe('MeSH path UNCHANGED (no regression from SAB parameterization)', () => {
    it('default finalize still stamps MSH anchor for a MeSH harvest', () => {
        const acc = newConceptAccumulator();
        ingestMrconsoRow(acc, row({ SAB: 'MSH', CODE: 'D000818', CUI: 'C0001688' }), MESH_SAB);
        const c = finalizeConcepts(acc).concepts[0]; // DEFAULTS to MeSH (no args)
        expect(c.sab).toBe('MSH');
        expect(c.anchor_payload).toBe('MSH:D000818');
        expect(c.canonicalization_version).toBe('mesh.concept.v1.0');
        expect(MESH_SAB).toBe('MSH');
        expect(MESH_CANONICALIZATION_VERSION).toBe('mesh.concept.v1.0');
    });

    it('a SNOMED row never increments the MSH distinct-CODE counter (per-SAB isolation)', () => {
        const fin = ingestSnomed([row({ CODE: 'SN', SAB: 'SNOMEDCT_US' })]);
        expect(fin.distinctCodeBySab.MSH).toBe(0);
        expect(fin.distinctCodeBySab.SNOMEDCT_US).toBe(1);
    });
});
