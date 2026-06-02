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
                { mesh_sid: '40374b17c32e1493bd60b96c1c2bd2c6', code: 'D000818', confidence: 'high', match_method: 'code_join' },
                { mesh_sid: 'abc', code: 'D006801', confidence: 'low', match_method: 'string_resolve' },
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

    it('mesh_links with a bad match_method enum value fails validation', () => {
        const paper = basePaper({
            mesh_links: [{ mesh_sid: 's', code: 'c', confidence: 'high', match_method: 'not_a_mode' }],
        });
        const { valid, errors } = validate(paper, PAPER_SCHEMA);
        expect(valid).toBe(false);
        expect(errors.some(e => e.path.includes('mesh_links') && /enum/.test(e.error))).toBe(true);
    });

    it('COMPLIANCE (PR-UMLS-2a): mesh_links itemShape = {mesh_sid, code, confidence, match_method}; NO cui', () => {
        // The itemShape keys are exactly the 4 public allowlist fields; the proprietary
        // `cui` is NOT a declared field (and the builder never emits it). A link carrying
        // `cui` is an extra field; the schema's mesh_sid/code/confidence/match_method are
        // the only declared keys.
        const shape = PAPER_SCHEMA.mesh_links.itemShape;
        expect(Object.keys(shape).sort()).toEqual(['code', 'confidence', 'match_method', 'mesh_sid']);
        expect(shape).not.toHaveProperty('cui');
        expect(shape).not.toHaveProperty('match');
        expect(shape.match_method.enum).toEqual(['code_join', 'string_resolve']);
    });

    it('mesh_descriptors entry missing required ui fails validation', () => {
        const paper = basePaper({ mesh_descriptors: [{ name: 'No UI' }] });
        const { valid, errors } = validate(paper, PAPER_SCHEMA);
        expect(valid).toBe(false);
        expect(errors.some(e => e.path.includes('mesh_descriptors') && /required/.test(e.error))).toBe(true);
    });
});
