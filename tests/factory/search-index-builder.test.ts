/**
 * Tests for V0.5.3 Tier 1.5 FTS5 search index builder.
 *
 * Anchored in §9.4 design: full-text search over Tier 1 cumulative
 * aggregated. Verifies the indexer produces a queryable SQLite FTS5 db
 * with expected schemas and that representative searches return hits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { buildIndex } from '../../scripts/factory/lib/search-index-builder.js';

let tmpDir: string;
let inputDir: string;
let outputPath: string;

async function writeJsonl(fname: string, records: object[]) {
    const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(path.join(inputDir, fname), text, 'utf-8');
}

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sciweon-search-test-'));
    inputDir = path.join(tmpDir, 'linked');
    await fs.mkdir(inputDir, { recursive: true });
    outputPath = path.join(tmpDir, 'sciweon-search.db');
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCompound(cid: number, synonyms: string[], iupac?: string) {
    return {
        id: `sciweon::compound::CID:${cid}`,
        pubchem_cid: cid,
        inchi_key: `STUB${cid.toString().padStart(11, '0')}-AAAAAAAAAA-A`,
        smiles_canonical: 'CC(=O)O',
        inchi: 'InChI=1S/...',
        molecular_formula: 'C9H8O4',
        molecular_weight: { value: 180.16, unit: 'Da' },
        synonyms,
        iupac_name: iupac || null,
        provenance: { sources: [{ source: 'pubchem', source_id: String(cid), timestamp: '2026-05-17T00:00:00Z', extraction_method: 'test' }] },
        confidence: { overall: 80, structural: 80, bioactivity: 80, clinical: 80, method: 'cross_source_consensus_v1', cross_source_agreement: { structural_match: true, conflicts: [] } },
    };
}

function makeTrial(ncIdNum: string, title: string, conditions: string[]) {
    return {
        id: `sciweon::trial::NCT:${ncIdNum}`,
        nct_id: ncIdNum,
        status: 'COMPLETED',
        brief_title: title,
        conditions,
        interventions: [{ name: 'metformin', type: 'DRUG' }],
    };
}

function makePaper(doi: string, title: string, year: number) {
    return {
        id: `sciweon::paper::DOI:${doi}`,
        doi,
        title,
        publication_year: year,
    };
}

describe('buildIndex', () => {
    it('produces FTS5 db with 3 virtual tables', async () => {
        await writeJsonl('compounds-enriched.jsonl', [makeCompound(2244, ['aspirin', 'acetylsalicylic acid'])]);
        await writeJsonl('trials.jsonl', []);
        await writeJsonl('papers.jsonl', []);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.compoundCount).toBe(1);

        const db = new Database(outputPath, { readonly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
        const tableNames = tables.map(t => t.name);
        expect(tableNames).toContain('compound_search');
        expect(tableNames).toContain('trial_search');
        expect(tableNames).toContain('paper_search');
        db.close();
    });

    it('compound search finds by name', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(2244, ['aspirin', 'acetylsalicylic acid'], '2-acetyloxybenzoic acid'),
            makeCompound(4091, ['metformin', 'glucophage'], '1,1-dimethylbiguanide'),
            makeCompound(3672, ['ibuprofen'], '2-(4-isobutylphenyl)propanoic acid'),
        ]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.compoundCount).toBe(3);

        const db = new Database(outputPath, { readonly: true });
        const results = db.prepare("SELECT cid FROM compound_search WHERE compound_search MATCH ? LIMIT 5").all('metformin') as Array<{cid: string}>;
        expect(results.length).toBe(1);
        expect(results[0].cid).toBe('sciweon::compound::CID:4091');
        db.close();
    });

    it('compound search finds by IUPAC fragment', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(2244, ['aspirin'], '2-acetyloxybenzoic acid'),
            makeCompound(4091, ['metformin'], '1,1-dimethylbiguanide'),
        ]);

        const stats = await buildIndex({ inputDir, outputPath });
        const db = new Database(outputPath, { readonly: true });
        const results = db.prepare("SELECT cid FROM compound_search WHERE compound_search MATCH ? LIMIT 5").all('acetyloxybenzoic') as Array<{cid: string}>;
        expect(results.length).toBe(1);
        expect(results[0].cid).toBe('sciweon::compound::CID:2244');
        db.close();
    });

    it('compound search finds by synonym fragment', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(4091, ['metformin', 'glucophage', 'fortamet'], 'dimethylbiguanide'),
        ]);

        const stats = await buildIndex({ inputDir, outputPath });
        const db = new Database(outputPath, { readonly: true });
        const r1 = db.prepare("SELECT cid FROM compound_search WHERE compound_search MATCH ?").all('glucophage') as Array<{cid: string}>;
        const r2 = db.prepare("SELECT cid FROM compound_search WHERE compound_search MATCH ?").all('fortamet') as Array<{cid: string}>;
        expect(r1.length).toBe(1);
        expect(r2.length).toBe(1);
        db.close();
    });

    it('trial search finds by title token', async () => {
        await writeJsonl('compounds-enriched.jsonl', []);
        await writeJsonl('trials.jsonl', [
            makeTrial('04123456', 'Metformin for Type 2 Diabetes', ['diabetes', 'insulin resistance']),
            makeTrial('04999999', 'Aspirin in Cardiac Prevention', ['cardiovascular disease']),
        ]);
        await writeJsonl('papers.jsonl', []);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.trialCount).toBe(2);

        const db = new Database(outputPath, { readonly: true });
        const r = db.prepare("SELECT trial_id FROM trial_search WHERE trial_search MATCH ? LIMIT 5").all('diabetes') as Array<{trial_id: string}>;
        expect(r.length).toBe(1);
        expect(r[0].trial_id).toBe('sciweon::trial::NCT:04123456');
        db.close();
    });

    it('paper search finds by title token', async () => {
        await writeJsonl('compounds-enriched.jsonl', []);
        await writeJsonl('trials.jsonl', []);
        await writeJsonl('papers.jsonl', [
            makePaper('10.1038/nature12373', 'Mechanism of metformin in diabetes', 2013),
            makePaper('10.1056/nejm200001063', 'Aspirin Resistance and Cardiovascular Events', 2005),
        ]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.paperCount).toBe(2);

        const db = new Database(outputPath, { readonly: true });
        const r = db.prepare("SELECT paper_id FROM paper_search WHERE paper_search MATCH ?").all('metformin') as Array<{paper_id: string}>;
        expect(r.length).toBe(1);
        expect(r[0].paper_id).toBe('sciweon::paper::DOI:10.1038/nature12373');
        db.close();
    });

    it('handles absent input files gracefully (Stage 3 partial run)', async () => {
        // Only compounds present, trials + papers absent
        await writeJsonl('compounds-enriched.jsonl', [makeCompound(2244, ['aspirin'])]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.compoundCount).toBe(1);
        expect(stats.trialCount).toBe(0);
        expect(stats.paperCount).toBe(0);

        // db still valid (3 empty tables + 1 populated)
        const db = new Database(outputPath, { readonly: true });
        const trialRows = db.prepare("SELECT COUNT(*) as c FROM trial_search").get() as {c: number};
        expect(trialRows.c).toBe(0);
        db.close();
    });

    it('rejects compound records lacking required fields (id / inchi_key)', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(2244, ['aspirin']),
            { id: 'sciweon::compound::CID:9999', /* missing inchi_key */ synonyms: ['mystery'] } as any,
        ]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.compoundCount).toBe(1);  // only aspirin indexed
    });

    it('builds against 1000-compound dataset in under 5 seconds (perf smoke)', async () => {
        const compounds = Array.from({ length: 1000 }, (_, i) =>
            makeCompound(10000 + i, [`compound-${i}`, `synonym-${i}-a`, `synonym-${i}-b`], `iupac-name-${i}`),
        );
        await writeJsonl('compounds-enriched.jsonl', compounds);

        const t0 = Date.now();
        const stats = await buildIndex({ inputDir, outputPath });
        const elapsed = Date.now() - t0;

        expect(stats.compoundCount).toBe(1000);
        expect(elapsed).toBeLessThan(5000);
    });
});
