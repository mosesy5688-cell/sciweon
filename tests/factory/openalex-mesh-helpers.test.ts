// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { extractMesh, extractMeshDescriptors } from '../../scripts/ingestion/adapters/openalex-helpers.js';

// OpenAlex mesh object shape: {descriptor_ui, descriptor_name, qualifier_ui,
// qualifier_name, is_major_topic}.
const RAW = {
    mesh: [
        { descriptor_ui: 'D000818', descriptor_name: 'Adipose Tissue', is_major_topic: false },
        { descriptor_ui: 'D006801', descriptor_name: 'Humans', is_major_topic: true },
        { descriptor_ui: '', descriptor_name: 'No UI here' },   // empty ui -> filtered by descriptors
        { descriptor_ui: null, descriptor_name: 'Null UI' },    // null ui -> filtered
    ],
};

describe('extractMesh -- UNCHANGED string path (PR-UMLS-2 DECISION 1)', () => {
    it('returns string[] of descriptor_name (Boolean filter only)', () => {
        const r = extractMesh(RAW);
        expect(r).toEqual(['Adipose Tissue', 'Humans', 'No UI here', 'Null UI']);
        for (const x of r) expect(typeof x).toBe('string');
    });
    it('missing mesh -> []', () => {
        expect(extractMesh({})).toEqual([]);
    });
});

describe('extractMeshDescriptors -- ADDITIVE code channel', () => {
    it('maps descriptor_ui + name and filters missing/empty ui', () => {
        const r = extractMeshDescriptors(RAW);
        expect(r).toEqual([
            { ui: 'D000818', name: 'Adipose Tissue' },
            { ui: 'D006801', name: 'Humans' },
        ]);
    });
    it('missing mesh -> []', () => {
        expect(extractMeshDescriptors({})).toEqual([]);
    });
    it('every returned entry has a non-empty string ui', () => {
        for (const m of extractMeshDescriptors(RAW)) {
            expect(typeof m.ui).toBe('string');
            expect(m.ui.length).toBeGreaterThan(0);
        }
    });
});
