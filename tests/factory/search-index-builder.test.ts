/**
 * Tests for V0.5.3 search index builder (JSON inverted index per §10).
 * Replaces FTS5 SQLite tests after framing correction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildIndex } from '../../scripts/factory/lib/search-index-builder.js';

let tmpDir: string;
let inputDir: string;
let outputPath: string;

async function writeJsonl(fname: string, records: object[]) {
    const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(path.join(inputDir, fname), text, 'utf-8');
}

async function readIndex(): Promise<any> {
    return JSON.parse(await fs.readFile(outputPath, 'utf-8'));
}

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sciweon-search-test-'));
    inputDir = path.join(tmpDir, 'linked');
    await fs.mkdir(inputDir, { recursive: true });
    outputPath = path.join(tmpDir, 'sciweon-search-index.json');
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

function makeTrial(nctId: string, title: string, conditions: string[]) {
    return {
        id: `sciweon::trial::NCT:${nctId}`,
        nct_id: nctId,
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

describe('buildIndex (JSON inverted index)', () => {
    it('produces version + per-type buckets', async () => {
        await writeJsonl('compounds-enriched.jsonl', [makeCompound(2244, ['aspirin'])]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.compoundCount).toBe(1);

        const idx = await readIndex();
        expect(idx.version).toBe('0.5.3');
        expect(idx.built_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(idx.compounds).toBeDefined();
        expect(idx.trials).toBeDefined();
        expect(idx.papers).toBeDefined();
    });

    it('compound search finds by name token', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(2244, ['aspirin', 'acetylsalicylic acid']),
            makeCompound(4091, ['metformin', 'glucophage']),
            makeCompound(3672, ['ibuprofen']),
        ]);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(idx.compounds.tokens['metformin']).toEqual(['sciweon::compound::CID:4091']);
        expect(idx.compounds.tokens['aspirin']).toEqual(['sciweon::compound::CID:2244']);
        expect(idx.compounds.tokens['ibuprofen']).toEqual(['sciweon::compound::CID:3672']);
    });

    it('compound search indexes IUPAC tokens', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(2244, ['aspirin'], '2-acetyloxybenzoic acid'),
        ]);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(idx.compounds.tokens['acetyloxybenzoic']).toEqual(['sciweon::compound::CID:2244']);
    });

    it('compound search indexes all synonym tokens', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(4091, ['metformin', 'glucophage', 'fortamet'], 'dimethylbiguanide'),
        ]);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(idx.compounds.tokens['glucophage']).toEqual(['sciweon::compound::CID:4091']);
        expect(idx.compounds.tokens['fortamet']).toEqual(['sciweon::compound::CID:4091']);
        expect(idx.compounds.tokens['dimethylbiguanide']).toEqual(['sciweon::compound::CID:4091']);
    });

    it('trial index tokenizes title + conditions', async () => {
        await writeJsonl('compounds-enriched.jsonl', []);
        await writeJsonl('trials.jsonl', [
            makeTrial('04123456', 'Metformin for Type 2 Diabetes', ['diabetes', 'insulin resistance']),
        ]);
        await writeJsonl('papers.jsonl', []);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(idx.trials.tokens['diabetes']).toEqual(['sciweon::trial::NCT:04123456']);
        expect(idx.trials.tokens['metformin']).toEqual(['sciweon::trial::NCT:04123456']);
        expect(idx.trials.meta['sciweon::trial::NCT:04123456'].status).toBe('COMPLETED');
    });

    it('paper index tokenizes title', async () => {
        await writeJsonl('compounds-enriched.jsonl', []);
        await writeJsonl('trials.jsonl', []);
        await writeJsonl('papers.jsonl', [
            makePaper('10.1038/nature12373', 'Mechanism of metformin in diabetes', 2013),
        ]);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(idx.papers.tokens['mechanism']).toEqual(['sciweon::paper::DOI:10.1038/nature12373']);
        expect(idx.papers.meta['sciweon::paper::DOI:10.1038/nature12373'].year).toBe(2013);
    });

    it('rejects records lacking required fields', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(2244, ['aspirin']),
            { id: 'sciweon::compound::CID:9999', synonyms: ['mystery'] } as any,
        ]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.compoundCount).toBe(1);
    });

    it('handles absent input files gracefully', async () => {
        await writeJsonl('compounds-enriched.jsonl', [makeCompound(2244, ['aspirin'])]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.compoundCount).toBe(1);
        expect(stats.trialCount).toBe(0);
        expect(stats.paperCount).toBe(0);

        const idx = await readIndex();
        expect(Object.keys(idx.trials.tokens).length).toBe(0);
        expect(Object.keys(idx.papers.tokens).length).toBe(0);
    });

    it('compound meta carries name + snippet', async () => {
        await writeJsonl('compounds-enriched.jsonl', [
            makeCompound(2244, ['aspirin', 'acetylsalicylic acid', 'salicylic acid acetate']),
        ]);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        const meta = idx.compounds.meta['sciweon::compound::CID:2244'];
        expect(meta.name).toBe('aspirin');
        expect(meta.snippet).toContain('C9H8O4');
    });

    it('1000-compound dataset builds in under 5 seconds (perf smoke)', async () => {
        const compounds = Array.from({ length: 1000 }, (_, i) =>
            makeCompound(10000 + i, [`compound-${i}`, `syn-${i}-a`, `syn-${i}-b`], `iupac-${i}`),
        );
        await writeJsonl('compounds-enriched.jsonl', compounds);

        const t0 = Date.now();
        const stats = await buildIndex({ inputDir, outputPath });
        const elapsed = Date.now() - t0;

        expect(stats.compoundCount).toBe(1000);
        expect(elapsed).toBeLessThan(5000);
    });
});
