/**
 * Tests for C2-3 target inverse-pivot index builder.
 *
 * Determinism guard (Constitution V16.1 §7): byte-identical output across
 * two runs on identical input. Asserts the sort step in the builder is
 * load-bearing — without it the two runs would diverge in Set iteration
 * order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildIndex } from '../../scripts/factory/lib/target-index-builder.js';

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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sciweon-target-test-'));
    inputDir = path.join(tmpDir, 'linked');
    await fs.mkdir(inputDir, { recursive: true });
    outputPath = path.join(tmpDir, 'target-index.json');
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function bio(id: string, compoundId: string, uniprot: string | null, meta: Partial<{ protein_name: string; gene_symbol: string; chembl_id: string; taxon_id: number }> = {}) {
    const target: any = {};
    if (uniprot) target.uniprot_accession = uniprot;
    if (meta.protein_name) target.protein_name = meta.protein_name;
    if (meta.gene_symbol) target.gene_symbol = meta.gene_symbol;
    if (meta.chembl_id) target.chembl_id = meta.chembl_id;
    if (meta.taxon_id) target.organism = { taxon_id: meta.taxon_id, scientific_name: 'Homo sapiens' };
    return {
        id,
        compound_id: compoundId,
        target_id: meta.chembl_id ?? 'CHEMBL999',
        target,
        activity_type: 'IC50',
        value: 1,
        unit: 'nM',
        is_active: true,
    };
}

function trial(id: string, compoundIds: string[]) {
    return {
        id,
        nct_id: id.replace('sciweon::trial::NCT:', ''),
        interventions: compoundIds.map(cid => ({ name: 'x', type: 'DRUG', compound_id: cid, mapping_confidence: 60 })),
    };
}

function neg(id: string, compoundId: string) {
    return { id, evidence_type: 'inactive_bioassay', subject: { compound_id: compoundId }, severity: 'minor' };
}

describe('buildTargetIndex', () => {
    it('produces version + targets object', async () => {
        await writeJsonl('bioactivities.jsonl', [
            bio('sciweon::bioactivity::1', 'sciweon::compound::CID:1', 'P00533', { protein_name: 'EGFR', gene_symbol: 'EGFR', chembl_id: 'CHEMBL203' }),
        ]);
        await writeJsonl('trials.jsonl', []);
        await writeJsonl('neg-evidence.jsonl', []);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.targetCount).toBe(1);

        const idx = await readIndex();
        expect(idx.version).toBe('0.6.0');
        expect(idx.built_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(idx.targets['P00533']).toBeDefined();
        expect(idx.targets['P00533'].protein_name).toBe('EGFR');
        expect(idx.targets['P00533'].chembl_target_id).toBe('CHEMBL203');
    });

    it('groups bioactivities by uniprot, dropping ChEMBL-only records', async () => {
        await writeJsonl('bioactivities.jsonl', [
            bio('sciweon::bioactivity::1', 'sciweon::compound::CID:1', 'P00533'),
            bio('sciweon::bioactivity::2', 'sciweon::compound::CID:2', 'P00533'),
            bio('sciweon::bioactivity::3', 'sciweon::compound::CID:3', 'P10000'),
            bio('sciweon::bioactivity::4', 'sciweon::compound::CID:4', null), // ChEMBL-only — should be skipped in v1
        ]);
        await writeJsonl('trials.jsonl', []);
        await writeJsonl('neg-evidence.jsonl', []);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(Object.keys(idx.targets).sort()).toEqual(['P00533', 'P10000']);
        expect(idx.targets['P00533'].compound_ids).toEqual(['sciweon::compound::CID:1', 'sciweon::compound::CID:2']);
        expect(idx.targets['P00533'].bioactivity_ids).toEqual(['sciweon::bioactivity::1', 'sciweon::bioactivity::2']);
        expect(idx.targets['P10000'].compound_ids).toEqual(['sciweon::compound::CID:3']);
    });

    it('fans trials out via interventions[].compound_id', async () => {
        await writeJsonl('bioactivities.jsonl', [
            bio('sciweon::bioactivity::1', 'sciweon::compound::CID:1', 'P00533'),
            bio('sciweon::bioactivity::2', 'sciweon::compound::CID:2', 'P10000'),
        ]);
        await writeJsonl('trials.jsonl', [
            trial('sciweon::trial::NCT:00000001', ['sciweon::compound::CID:1', 'sciweon::compound::CID:2']),
            trial('sciweon::trial::NCT:00000002', ['sciweon::compound::CID:1']),
            trial('sciweon::trial::NCT:00000003', ['sciweon::compound::CID:999']),  // compound not in bioactivities → ignored
        ]);
        await writeJsonl('neg-evidence.jsonl', []);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(idx.targets['P00533'].trial_ids).toEqual([
            'sciweon::trial::NCT:00000001',
            'sciweon::trial::NCT:00000002',
        ]);
        expect(idx.targets['P10000'].trial_ids).toEqual([
            'sciweon::trial::NCT:00000001',
        ]);
    });

    it('fans neg-evidence out via subject.compound_id', async () => {
        await writeJsonl('bioactivities.jsonl', [
            bio('sciweon::bioactivity::1', 'sciweon::compound::CID:1', 'P00533'),
        ]);
        await writeJsonl('trials.jsonl', []);
        await writeJsonl('neg-evidence.jsonl', [
            neg('sciweon::neg::bioassay::1', 'sciweon::compound::CID:1'),
            neg('sciweon::neg::boxed::1', 'sciweon::compound::CID:1'),
            neg('sciweon::neg::trial::1', 'sciweon::compound::CID:999'),  // not in bioactivities → ignored
        ]);

        await buildIndex({ inputDir, outputPath });
        const idx = await readIndex();

        expect(idx.targets['P00533'].negative_evidence_ids).toEqual([
            'sciweon::neg::bioassay::1',
            'sciweon::neg::boxed::1',
        ]);
    });

    it('produces deterministic byte-identical output across two builds (§7)', async () => {
        // Shuffled-looking input to expose any reliance on Map/Set iteration order.
        await writeJsonl('bioactivities.jsonl', [
            bio('sciweon::bioactivity::z', 'sciweon::compound::CID:7', 'P10000'),
            bio('sciweon::bioactivity::a', 'sciweon::compound::CID:3', 'P00533'),
            bio('sciweon::bioactivity::m', 'sciweon::compound::CID:5', 'P00533'),
            bio('sciweon::bioactivity::c', 'sciweon::compound::CID:1', 'P10000'),
        ]);
        await writeJsonl('trials.jsonl', [
            trial('sciweon::trial::NCT:99999999', ['sciweon::compound::CID:7', 'sciweon::compound::CID:1']),
            trial('sciweon::trial::NCT:11111111', ['sciweon::compound::CID:3']),
        ]);
        await writeJsonl('neg-evidence.jsonl', []);

        await buildIndex({ inputDir, outputPath });
        const first = await fs.readFile(outputPath, 'utf-8');
        const firstParsed = JSON.parse(first);

        await buildIndex({ inputDir, outputPath });
        const second = await fs.readFile(outputPath, 'utf-8');
        const secondParsed = JSON.parse(second);

        // built_at obviously differs; strip it before comparison.
        firstParsed.built_at = '';
        secondParsed.built_at = '';
        expect(JSON.stringify(firstParsed)).toBe(JSON.stringify(secondParsed));

        // Key order in serialized output must be ascending.
        const keys = Object.keys(firstParsed.targets);
        expect(keys).toEqual([...keys].sort());
    });

    it('handles absent input files gracefully', async () => {
        // Only bioactivities present; trials + neg-evidence absent
        await writeJsonl('bioactivities.jsonl', [
            bio('sciweon::bioactivity::1', 'sciweon::compound::CID:1', 'P00533'),
        ]);

        const stats = await buildIndex({ inputDir, outputPath });
        expect(stats.targetCount).toBe(1);
        expect(stats.trialEdges).toBe(0);
        expect(stats.negEvidenceEdges).toBe(0);

        const idx = await readIndex();
        expect(idx.targets['P00533'].trial_ids).toEqual([]);
        expect(idx.targets['P00533'].negative_evidence_ids).toEqual([]);
    });
});
