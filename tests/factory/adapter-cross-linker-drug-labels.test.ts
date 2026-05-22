/**
 * Tests for cycle 21 PR-prep — drug-labels.jsonl emission in adapter-cross-linker.
 *
 * Closes the gap revealed 2026-05-22: F4 logged drug-labels.jsonl as
 * (absent, skip) every cron because nothing materialized it from the
 * adapter cumulative. PR #101 LOINC-34084-4 expansion was dead code
 * until this emit step lands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runCrossLinker } from '../../scripts/factory/adapter-cross-linker.js';

let tmpDir: string;
let compoundsPath: string;
let adapterPath: string;
let drugLabelsPath: string;

async function writeJsonl(filePath: string, records: object[]) {
    const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(filePath, text, 'utf-8');
}

async function readJsonl(filePath: string): Promise<any[]> {
    const text = await fs.readFile(filePath, 'utf-8');
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sciweon-adapter-cl-test-'));
    compoundsPath = path.join(tmpDir, 'compounds-enriched.jsonl');
    adapterPath = path.join(tmpDir, 'adapter-cumulative.jsonl');
    drugLabelsPath = path.join(tmpDir, 'drug-labels.jsonl');
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function compound(cid: number, rxcui: string[] = []) {
    return {
        id: `sciweon::compound::CID:${cid}`,
        pubchem_cid: cid,
        inchi_key: `STUB${cid.toString().padStart(11, '0')}-AAAAAAAAAA-A`,
        smiles_canonical: 'CC(=O)O',
        molecular_formula: 'C9H8O4',
        molecular_weight: { value: 180.16, unit: 'Da' },
        external_ids: { rxcui },
        drug_status: { atc_codes: [] },
        provenance: { sources: [], last_updated: '2026-05-22T00:00:00Z' },
        confidence: { overall: 80, method: 'cross_source_consensus_v1' },
        stats: {},
    };
}

function drugLabel(setid: string, rxcui: string[] = [], adverseReactions: string | null = null) {
    return {
        id: `sciweon::drug_label::setid::${setid}`,
        setid,
        spl_version: '1',
        title: `Drug label ${setid}`,
        label_type: 'HUMAN PRESCRIPTION DRUG',
        rxcui,
        application_numbers: [],
        dosage_forms: [],
        sections: {
            boxed_warning: null,
            indications: null,
            dosage: null,
            contraindications: null,
            drug_interactions: null,
            adverse_reactions: adverseReactions,
            mechanism_of_action: null,
            pharmacokinetics: null,
            warnings_precautions: null,
        },
        has_boxed_warning: false,
        sections_extracted: true,
        published_date: '2026-05-22',
    };
}

describe('runCrossLinker — drug-labels emit', () => {
    it('writes the full DrugLabel records (including sections.adverse_reactions) to drug-labels.jsonl', async () => {
        await writeJsonl(compoundsPath, [compound(2244, ['11289'])]);
        await writeJsonl(adapterPath, [
            { id: 'sciweon::atc_class::B01AC06', level5: 'B01AC06', who_name: 'acetylsalicylic acid', level1: 'B' },
            drugLabel('aaa-111', ['11289'], 'Most common adverse reactions in clinical studies were headache, nausea.'),
            drugLabel('bbb-222', ['99999'], 'Frequency 1-10% included rash.'),
        ]);

        const stats = await runCrossLinker({ compoundsPath, adapterPath, drugLabelsPath });
        expect(stats?.drugLabelsCount).toBe(2);

        const out = await readJsonl(drugLabelsPath);
        expect(out).toHaveLength(2);
        expect(out[0].id).toBe('sciweon::drug_label::setid::aaa-111');
        expect(out[0].sections.adverse_reactions).toMatch(/headache, nausea/);
        expect(out[1].id).toBe('sciweon::drug_label::setid::bbb-222');
        expect(out[1].sections.adverse_reactions).toMatch(/rash/);
    });

    it('sorts records by id for byte-deterministic output (§7)', async () => {
        await writeJsonl(compoundsPath, [compound(1, ['x'])]);
        // Intentionally write records in non-sorted order.
        await writeJsonl(adapterPath, [
            drugLabel('zzz', [], 'z'),
            drugLabel('aaa', [], 'a'),
            drugLabel('mmm', [], 'm'),
        ]);

        await runCrossLinker({ compoundsPath, adapterPath, drugLabelsPath });
        const out = await readJsonl(drugLabelsPath);
        const ids = out.map(r => r.id);
        expect(ids).toEqual([...ids].sort());
    });

    it('writes an empty file when no drug_label records are present (snapshot-builder still picks it up cleanly)', async () => {
        await writeJsonl(compoundsPath, [compound(1)]);
        await writeJsonl(adapterPath, [
            { id: 'sciweon::atc_class::A01AA01', level5: 'A01AA01' },
        ]);

        const stats = await runCrossLinker({ compoundsPath, adapterPath, drugLabelsPath });
        expect(stats?.drugLabelsCount).toBe(0);

        const content = await fs.readFile(drugLabelsPath, 'utf-8');
        expect(content).toBe('');
    });
});
