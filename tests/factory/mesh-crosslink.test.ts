// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    normalizeMeshString, buildMeshByCode, buildMeshByString,
    buildMeshLinksForPaper, enrichPapersWithMeshLinks,
} from '../../scripts/factory/lib/mesh-crosslink-helpers.js';

function stampedConcept(overrides = {}) {
    return {
        code: 'D000818', cui: 'C0001688', sab: 'MSH',
        preferred_str: 'Adipose Tissue', synonyms: ['Fat, Body'],
        anchor_payload: 'MSH:D000818', canonicalization_version: 'mesh.concept.v1.0',
        sid_s: '40374b17c32e1493bd60b96c1c2bd2c6', sid_c: 'be507120e7ea5dcd273f57761fada499',
        ...overrides,
    };
}

describe('normalizeMeshString', () => {
    it('lowercases + trims', () => {
        expect(normalizeMeshString('  Adipose Tissue ')).toBe('adipose tissue');
    });
    it('null/empty -> null', () => {
        expect(normalizeMeshString(null)).toBe(null);
        expect(normalizeMeshString('   ')).toBe(null);
    });
});

describe('buildMeshByCode / buildMeshByString', () => {
    it('byCode indexes stamped concepts; un-stamped counted (not joined)', () => {
        const { byCode, missingSid } = buildMeshByCode([
            stampedConcept(),
            stampedConcept({ code: 'D999999', sid_s: undefined }), // un-stamped
        ]);
        expect(byCode.get('D000818').sid_s).toBe('40374b17c32e1493bd60b96c1c2bd2c6');
        expect(byCode.has('D999999')).toBe(false);
        expect(missingSid).toBe(1);
    });

    it('byString covers preferred_str + synonyms, first-write-wins, collision counted', () => {
        const { byString, collisions } = buildMeshByString([
            stampedConcept(),
            // distinct concept claiming the same normalized string -> collision
            stampedConcept({ code: 'D111111', sid_s: 'ffffffffffffffffffffffffffffffff', preferred_str: 'Adipose Tissue', synonyms: [] }),
        ]);
        expect(byString.get('adipose tissue').sid_s).toBe('40374b17c32e1493bd60b96c1c2bd2c6'); // first wins
        expect(byString.get('fat, body').code).toBe('D000818');
        expect(collisions).toBe(1);
    });
});

describe('buildMeshLinksForPaper -- Part A code_join', () => {
    it('descriptor ui code-joins to sid with high confidence', () => {
        const { byCode } = buildMeshByCode([stampedConcept()]);
        const { byString } = buildMeshByString([stampedConcept()]);
        const tel = { papers_processed: 0, terms_total: 0, code_join_hits: 0, string_resolve_hits: 0, no_match: 0, string_map_collisions: 0, no_match_samples: [] };
        const paper = { mesh_descriptors: [{ ui: 'D000818', name: 'Adipose Tissue' }], mesh_terms: ['Adipose Tissue'] };
        const links = buildMeshLinksForPaper(paper, { byCode, byString }, tel);
        expect(links).toHaveLength(1);
        expect(links[0]).toEqual({ mesh_sid: '40374b17c32e1493bd60b96c1c2bd2c6', code: 'D000818', confidence: 'high', match_method: 'code_join' });
        expect(tel.code_join_hits).toBe(1);
        // mesh_terms entry whose concept is already code-joined must NOT double-link
        expect(tel.string_resolve_hits).toBe(0);
    });
});

describe('buildMeshLinksForPaper -- Part B string_resolve fallback', () => {
    it('historical paper (mesh_terms only, no descriptors) string-resolves with low confidence', () => {
        const { byCode } = buildMeshByCode([stampedConcept()]);
        const { byString } = buildMeshByString([stampedConcept()]);
        const tel = { papers_processed: 0, terms_total: 0, code_join_hits: 0, string_resolve_hits: 0, no_match: 0, string_map_collisions: 0, no_match_samples: [] };
        const paper = { mesh_terms: ['Adipose Tissue'] }; // no mesh_descriptors
        const links = buildMeshLinksForPaper(paper, { byCode, byString }, tel);
        expect(links).toHaveLength(1);
        expect(links[0].match_method).toBe('string_resolve');
        expect(links[0].confidence).toBe('low');
        expect(links[0].mesh_sid).toBe('40374b17c32e1493bd60b96c1c2bd2c6');
        // PR-UMLS-2a: NO cui in any link; old `match` key gone (renamed to match_method).
        expect(links[0]).not.toHaveProperty('cui');
        expect(links[0]).not.toHaveProperty('match');
        expect(tel.string_resolve_hits).toBe(1);
    });
});

describe('no-match -> bucketed (not thrown, not dropped)', () => {
    it('counts no_match for an unknown code and an unknown string', () => {
        const { byCode } = buildMeshByCode([stampedConcept()]);
        const { byString } = buildMeshByString([stampedConcept()]);
        const tel = { papers_processed: 0, terms_total: 0, code_join_hits: 0, string_resolve_hits: 0, no_match: 0, string_map_collisions: 0, no_match_samples: [] };
        const paper = { mesh_descriptors: [{ ui: 'D000000', name: 'Nope' }], mesh_terms: ['totally unknown term'] };
        const links = buildMeshLinksForPaper(paper, { byCode, byString }, tel);
        expect(links).toHaveLength(0);
        expect(tel.no_match).toBe(2);
        expect(tel.no_match_samples).toContain('code:D000000');
        expect(tel.no_match_samples).toContain('str:totally unknown term');
    });
});

describe('fail-soft -- one bad term, valid ones still attach', () => {
    it('a no-match descriptor does not abort the paper; the good one still links', () => {
        const { byCode } = buildMeshByCode([stampedConcept()]);
        const { byString } = buildMeshByString([stampedConcept()]);
        const tel = { papers_processed: 0, terms_total: 0, code_join_hits: 0, string_resolve_hits: 0, no_match: 0, string_map_collisions: 0, no_match_samples: [] };
        const paper = { mesh_descriptors: [{ ui: 'D000000' }, { ui: 'D000818' }] };
        const links = buildMeshLinksForPaper(paper, { byCode, byString }, tel);
        expect(links).toHaveLength(1);
        expect(links[0].code).toBe('D000818');
        expect(tel.code_join_hits).toBe(1);
        expect(tel.no_match).toBe(1);
    });
});

describe('enrichPapersWithMeshLinks -- telemetry + idempotent overwrite', () => {
    it('attaches mesh_links + reports telemetry counts', () => {
        const concepts = [stampedConcept()];
        const papers = [
            { id: 'p1', mesh_descriptors: [{ ui: 'D000818' }], mesh_terms: ['Adipose Tissue'] },
            { id: 'p2', mesh_terms: ['Adipose Tissue'] },
            { id: 'p3', mesh_terms: ['unknown'] },
        ];
        const tel = enrichPapersWithMeshLinks(papers, concepts);
        expect(tel.papers_processed).toBe(3);
        expect(tel.code_join_hits).toBe(1);
        expect(tel.string_resolve_hits).toBe(1);
        expect(tel.no_match).toBe(1);
        expect(papers[0].mesh_links[0].match_method).toBe('code_join');
        expect(papers[1].mesh_links[0].match_method).toBe('string_resolve');
        expect(papers[2].mesh_links).toEqual([]);
    });

    it('idempotent -- re-run OVERWRITES (no duplicate) + never touches sid_s/sid_c', () => {
        const concepts = [stampedConcept()];
        const papers = [{ id: 'p1', sid_s: 'PAPER_SID_S', sid_c: 'PAPER_SID_C', mesh_descriptors: [{ ui: 'D000818' }] }];
        enrichPapersWithMeshLinks(papers, concepts);
        const firstLen = papers[0].mesh_links.length;
        enrichPapersWithMeshLinks(papers, concepts); // re-run
        expect(papers[0].mesh_links.length).toBe(firstLen); // overwrite, not append
        expect(papers[0].mesh_links).toHaveLength(1);
        // paper identity preserved
        expect(papers[0].sid_s).toBe('PAPER_SID_S');
        expect(papers[0].sid_c).toBe('PAPER_SID_C');
    });
});

// --- PR-HARDEN-1: the papers assertLoaded regression. The enricher OVERWRITES papers.jsonl in
// place, so empty papers must HALT before writeJsonl (refuse to truncate a real populated file).
// Run the REAL enricher in a temp cwd with controlled output/linked/*.jsonl, assert the loud HALT.
const MESH_ENRICHER = resolve('scripts/factory/mesh-crosslink-enricher.js');
function runMeshEnricher({ papers, concepts }) {
    const workDir = mkdtempSync(join(tmpdir(), 'mesh-xlink-halt-'));
    const linked = join(workDir, 'output', 'linked');
    mkdirSync(linked, { recursive: true });
    const dump = (recs) => recs.map(r => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : '');
    writeFileSync(join(linked, 'papers.jsonl'), dump(papers), 'utf-8');
    writeFileSync(join(linked, 'mesh-concepts.jsonl'), dump(concepts), 'utf-8');
    const result = spawnSync(process.execPath, [MESH_ENRICHER], { cwd: workDir, encoding: 'utf-8' });
    return { workDir, result, linked };
}

describe('PR-HARDEN-1 -- MeSH papers assertLoaded HALT (no silent truncation)', () => {
    it('EMPTY papers (concepts populated) HALTs -- refuses to truncate papers.jsonl', () => {
        const { workDir, result } = runMeshEnricher({ papers: [], concepts: [stampedConcept()] });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/HALT: 0 records loaded from .*papers\.jsonl/);
        rmSync(workDir, { recursive: true, force: true });
    });
    it('EMPTY concepts (papers populated) HALTs -- would zero every paper mesh_links', () => {
        const { workDir, result } = runMeshEnricher({ papers: [{ id: 'p1' }], concepts: [] });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/HALT: 0 records loaded from .*mesh-concepts\.jsonl/);
        rmSync(workDir, { recursive: true, force: true });
    });
    it('both populated -> exit 0 + papers.jsonl preserved (NOT truncated)', () => {
        const papers = [{ id: 'p1', mesh_descriptors: [{ ui: 'D000818' }] }];
        const { workDir, result, linked } = runMeshEnricher({ papers, concepts: [stampedConcept()] });
        expect(result.status).toBe(0);
        const outPapers = readFileSync(join(linked, 'papers.jsonl'), 'utf-8').split('\n').filter(Boolean);
        expect(outPapers).toHaveLength(1); // preserved, not truncated to empty
        rmSync(workDir, { recursive: true, force: true });
    });
});
