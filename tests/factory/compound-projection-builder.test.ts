// @ts-nocheck
/**
 * PR-COMPOUND-GUARD (Step-5a) — compound-projection-builder.
 *
 * Locks the two SERVING projections:
 *   1. compounds-search.jsonl carries EXACTLY the fields scoreMatch +
 *      summarize read, in their NESTED shapes -> summarize(projectionRecord)
 *      === summarize(fullRecord) (the id + nested-field coverage guard).
 *   2. xref-index.json normalized keys match classifyIdentifier for ALL 7
 *      non-CID kinds; first/lowest CID wins on collision.
 *   3. NO SILENT DROP on a malformed / non-numeric-cid line (LOUD throw).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildProjections, SEARCH_PROJECTION_FILE, XREF_INDEX_FILE } from '../../scripts/factory/lib/compound-projection-builder.js';
import { summarize } from '../../src/worker/lib/compound-search';
import { classifyIdentifier } from '../../src/worker/lib/entity-resolver';

let dir: string;

const FULL_ASPIRIN = {
    id: 'sciweon::compound::CID:2244',
    pubchem_cid: 2244,
    chembl_id: 'CHEMBL25',
    inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
    iupac_name: '2-acetyloxybenzoic acid',
    synonyms: ['aspirin', 'acetylsalicylic acid'],
    molecular_formula: 'C9H8O4',
    molecular_weight: { value: 180.16, unit: 'Da' },
    drug_status: { max_phase: 4 },
    confidence: { overall: 80 },
    // fields the projection MUST exclude (uncap-invariance):
    fda_signals: [{ a: 1 }, { b: 2 }],
    external_ids: {
        unii: 'R16CO5Y76E', drugbank_id: 'DB00945', chebi_id: 'CHEBI:15365',
        kegg_drug_id: 'D00109', rxcui: '1191',
    },
};

async function writeEnriched(records: object[]) {
    const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'compounds-enriched.jsonl'), text, 'utf-8');
}
async function readSearch(): Promise<any[]> {
    const t = await fs.readFile(path.join(dir, SEARCH_PROJECTION_FILE), 'utf-8');
    return t.split('\n').filter(Boolean).map(l => JSON.parse(l));
}
async function readXref(): Promise<any> {
    return JSON.parse(await fs.readFile(path.join(dir, XREF_INDEX_FILE), 'utf-8'));
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compound-proj-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('compound-projection-builder — search projection round-trip', () => {
    it('summarize(projectionRecord) === summarize(fullRecord) (id + nested-field coverage)', async () => {
        await writeEnriched([FULL_ASPIRIN]);
        await buildProjections({ inputDir: dir, outputDir: dir });
        const [proj] = await readSearch();
        expect(summarize(proj)).toEqual(summarize(FULL_ASPIRIN));
    });

    it('EXCLUDES fda_signals (uncap-invariant projection)', async () => {
        await writeEnriched([FULL_ASPIRIN]);
        await buildProjections({ inputDir: dir, outputDir: dir });
        const [proj] = await readSearch();
        expect(proj.fda_signals).toBeUndefined();
        // but keeps the full synonyms array (scoreMatch iterates every synonym)
        expect(proj.synonyms).toEqual(['aspirin', 'acetylsalicylic acid']);
    });

    it('emits CID-asc order', async () => {
        await writeEnriched([
            { ...FULL_ASPIRIN, id: 'sciweon::compound::CID:4091', pubchem_cid: 4091, chembl_id: 'CHEMBL1431', external_ids: {} },
            FULL_ASPIRIN,
        ]);
        await buildProjections({ inputDir: dir, outputDir: dir });
        const rows = await readSearch();
        expect(rows.map(r => r.pubchem_cid)).toEqual([2244, 4091]);
    });
});

describe('compound-projection-builder — xref-index (all 7 kinds)', () => {
    it('normalized keys match classifyIdentifier for every non-CID kind', async () => {
        await writeEnriched([FULL_ASPIRIN]);
        await buildProjections({ inputDir: dir, outputDir: dir });
        const { index, total_compounds } = await readXref();
        expect(total_compounds).toBe(1);
        const cases: [string, string][] = [
            ['CHEMBL25', 'chembl_id'],
            ['BSYNRYMUTXBXSQ-UHFFFAOYSA-N', 'inchi_key'],
            ['UNII:R16CO5Y76E', 'unii'],
            ['DB00945', 'drugbank_id'],
            ['CHEBI:15365', 'chebi_id'],
            ['D00109', 'kegg_drug_id'],
            ['RXCUI:1191', 'rxcui'],
        ];
        for (const [raw, kind] of cases) {
            const c = classifyIdentifier(raw)!;
            expect(c.kind).toBe(kind);
            // the index key is exactly classifyIdentifier's normalized form
            expect(index[kind][c.normalized]).toBe(2244);
        }
    });

    it('all 7 kinds are present as index partitions', async () => {
        await writeEnriched([FULL_ASPIRIN]);
        await buildProjections({ inputDir: dir, outputDir: dir });
        const { index } = await readXref();
        for (const k of ['chembl_id', 'inchi_key', 'unii', 'drugbank_id', 'chebi_id', 'kegg_drug_id', 'rxcui']) {
            expect(index[k]).toBeDefined();
        }
    });

    it('first/lowest CID wins on an id->multiple-cid collision', async () => {
        await writeEnriched([
            { id: 'a', pubchem_cid: 100, chembl_id: 'CHEMBL9', external_ids: {} },
            { id: 'b', pubchem_cid: 50, chembl_id: 'CHEMBL9', external_ids: {} },
        ]);
        const res = await buildProjections({ inputDir: dir, outputDir: dir });
        const { index } = await readXref();
        expect(index.chembl_id.CHEMBL9).toBe(50); // lowest CID kept
        expect(res.collisions).toBeGreaterThanOrEqual(1);
    });
});

describe('compound-projection-builder — NO SILENT DROP', () => {
    it('THROWS on a non-numeric (String-serialized) pubchem_cid', async () => {
        await writeEnriched([
            { pubchem_cid: 2244, chembl_id: 'CHEMBL25' },
            { pubchem_cid: '4091', chembl_id: 'CHEMBL1431' },
        ]);
        await expect(buildProjections({ inputDir: dir, outputDir: dir })).rejects.toThrow(/nonNumericCid=1/);
    });

    it('THROWS on a malformed JSON line', async () => {
        await fs.writeFile(path.join(dir, 'compounds-enriched.jsonl'),
            JSON.stringify({ pubchem_cid: 2244 }) + '\n{ not json\n', 'utf-8');
        await expect(buildProjections({ inputDir: dir, outputDir: dir })).rejects.toThrow(/malformed=1/);
    });
});
