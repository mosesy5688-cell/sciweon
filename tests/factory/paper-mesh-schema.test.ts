// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { PAPER_SCHEMA } from '../../src/lib/schemas/paper.js';
import { gate, validate } from '../../scripts/factory/lib/validation-gate.js';

function basePaper(overrides = {}) {
    return {
        id: 'sciweon::paper::W123456789',
        title: 'A study of adipose tissue',
        is_retracted: false,
        mesh_terms: ['Adipose Tissue', 'Humans'],
        provenance: {
            sources: [{
                source: 'openalex', source_id: 'W123456789',
                timestamp: '2026-06-01T00:00:00Z', extraction_method: 'openalex_works_api',
            }],
            last_updated: '2026-06-01T00:00:00Z',
        },
        ...overrides,
    };
}

describe('PAPER_SCHEMA -- mesh_descriptors + mesh_links additive fields', () => {
    it('a paper with mesh_descriptors + mesh_links passes the gate', () => {
        const paper = basePaper({
            mesh_descriptors: [
                { ui: 'D000818', name: 'Adipose Tissue' },
                { ui: 'D006801', name: 'Humans' },
            ],
            mesh_links: [
                { mesh_sid: '40374b17c32e1493bd60b96c1c2bd2c6', code: 'D000818', match: 'code_join', confidence: 'high' },
                { mesh_sid: 'abc', code: 'D006801', match: 'string_resolve', confidence: 'low' },
            ],
        });
        const result = gate(paper, PAPER_SCHEMA, `paper:${paper.id}`);
        expect(result.passed).toBe(true);
    });

    it('mesh_terms (string[]) shape is UNCHANGED -- still validates', () => {
        const paper = basePaper();
        expect(validate(paper, PAPER_SCHEMA).valid).toBe(true);
    });

    it('mesh_descriptors / mesh_links are optional (paper without them passes)', () => {
        const paper = basePaper();
        expect(validate(paper, PAPER_SCHEMA).valid).toBe(true);
    });

    it('mesh_links with a bad match enum value fails validation', () => {
        const paper = basePaper({
            mesh_links: [{ mesh_sid: 's', code: 'c', match: 'not_a_mode', confidence: 'high' }],
        });
        const { valid, errors } = validate(paper, PAPER_SCHEMA);
        expect(valid).toBe(false);
        expect(errors.some(e => e.path.includes('mesh_links') && /enum/.test(e.error))).toBe(true);
    });

    it('mesh_descriptors entry missing required ui fails validation', () => {
        const paper = basePaper({ mesh_descriptors: [{ name: 'No UI' }] });
        const { valid, errors } = validate(paper, PAPER_SCHEMA);
        expect(valid).toBe(false);
        expect(errors.some(e => e.path.includes('mesh_descriptors') && /required/.test(e.error))).toBe(true);
    });
});
