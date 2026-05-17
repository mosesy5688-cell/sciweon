/**
 * Tests for V0.5.2.1 cumulative aggregation merger.
 *
 * Anchored in [[feedback_cross_cycle_silent_data_loss]] — the pattern
 * we are explicitly preventing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { mergeRecords, mergeLocalAggregatedWithPrevious, MERGE_FILES } from '../../scripts/factory/lib/aggregated-merger.js';

const LINKED_DIR = './output/linked';

function compoundRec(cid: number, extra: Record<string, unknown> = {}) {
    return {
        id: `sciweon::compound::CID:${cid}`,
        pubchem_cid: cid,
        inchi_key: `STUB${cid.toString().padStart(11, '0')}-AAAAAAAAAA-A`,
        ...extra,
    };
}

function negRec(compoundCid: number, evidenceType: string, severity: string = 'minor') {
    return {
        id: `sciweon::neg::${evidenceType}::SRC${compoundCid}_${evidenceType}`,
        evidence_type: evidenceType,
        subject: { compound_id: `sciweon::compound::CID:${compoundCid}` },
        severity,
        observed_date: '2026-05-17T00:00:00Z',
    };
}

describe('mergeRecords', () => {
    it('replaces by id (newer cycle wins)', () => {
        const previous = [
            compoundRec(100, { stub_field: 'old' }),
            compoundRec(101, { stub_field: 'old' }),
        ];
        const current = [
            compoundRec(100, { stub_field: 'new' }),  // replaces
            compoundRec(200, { stub_field: 'new' }),  // new
        ];
        const { merged, stats } = mergeRecords(current, previous, r => (r as any).id);
        expect(merged.length).toBe(3);  // 100 (replaced) + 101 (kept) + 200 (new)
        const c100 = merged.find((r: any) => r.id === 'sciweon::compound::CID:100') as any;
        expect(c100.stub_field).toBe('new');
        expect(stats.from_current).toBe(2);
        expect(stats.from_previous_kept).toBe(1);
        expect(stats.replaced_by_current).toBe(1);
    });

    it('empty previous = current passthrough', () => {
        const current = [compoundRec(1), compoundRec(2)];
        const { merged, stats } = mergeRecords(current, [], r => (r as any).id);
        expect(merged.length).toBe(2);
        expect(stats.from_previous_kept).toBe(0);
        expect(stats.replaced_by_current).toBe(0);
    });

    it('empty current = previous passthrough', () => {
        const previous = [compoundRec(1), compoundRec(2)];
        const { merged, stats } = mergeRecords([], previous, r => (r as any).id);
        expect(merged.length).toBe(2);
        expect(stats.from_current).toBe(0);
        expect(stats.from_previous_kept).toBe(2);
    });

    it('records without id are preserved via no-key passthrough', () => {
        const previous = [{ link_field: 'old' }];
        const current = [{ link_field: 'new' }];
        const { merged, stats } = mergeRecords(current, previous, () => null);
        expect(merged.length).toBe(2);  // both passthrough, no dedupe
        expect(stats.no_key_passthrough).toBe(2);
    });

    it('massive merge ~10K records stays within memory bound', () => {
        const previous = Array.from({ length: 10000 }, (_, i) => compoundRec(i));
        const current = Array.from({ length: 10000 }, (_, i) => compoundRec(i + 5000));
        const { merged } = mergeRecords(current, previous, r => (r as any).id);
        expect(merged.length).toBe(15000);  // 10K prev + 10K curr - 5K overlap
    });
});

describe('mergeLocalAggregatedWithPrevious (integration)', () => {
    async function writeLinked(fname: string, records: object[]) {
        await fs.mkdir(LINKED_DIR, { recursive: true });
        const text = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
        await fs.writeFile(path.join(LINKED_DIR, fname), text, 'utf-8');
    }

    async function readLinked(fname: string): Promise<object[]> {
        try {
            const text = await fs.readFile(path.join(LINKED_DIR, fname), 'utf-8');
            return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
        } catch { return []; }
    }

    beforeEach(async () => {
        // Clean LINKED_DIR before each test
        await fs.rm(LINKED_DIR, { recursive: true, force: true });
    });

    it('the canonical regression: CID 15730 survives a cycle that does not re-harvest it', async () => {
        // Stage 3 just ran on current cycle (CID 20001-25000): only CID 24100 has neg evidence
        await writeLinked('compounds-enriched.jsonl', [compoundRec(24100), compoundRec(24763)]);
        await writeLinked('neg-evidence.jsonl', [negRec(24100, 'trial_failure', 'major')]);

        // Previously published aggregated bundle had CID 15730 with 8 inactive_bioassay signals.
        const previousBuffers: Record<string, Buffer> = {};
        for (const f of MERGE_FILES) previousBuffers[f] = Buffer.alloc(0);
        previousBuffers['compounds-enriched.jsonl'] = Buffer.from([compoundRec(15730), compoundRec(20144)].map(r => JSON.stringify(r)).join('\n'));
        previousBuffers['neg-evidence.jsonl'] = Buffer.from(
            Array.from({ length: 8 }, (_, i) => negRec(15730, `inactive_bioassay_${i}`)).map(r => JSON.stringify(r)).join('\n'),
        );

        const result = await mergeLocalAggregatedWithPrevious(previousBuffers);

        const mergedCompounds = await readLinked('compounds-enriched.jsonl') as any[];
        const mergedNegEvidence = await readLinked('neg-evidence.jsonl') as any[];

        // CID 15730 still visible after merge (the bug we are fixing)
        expect(mergedCompounds.find(c => c.id === 'sciweon::compound::CID:15730')).toBeDefined();
        expect(mergedNegEvidence.filter(n => n.subject?.compound_id === 'sciweon::compound::CID:15730').length).toBe(8);
        // CID 24100 also present (current cycle data)
        expect(mergedCompounds.find(c => c.id === 'sciweon::compound::CID:24100')).toBeDefined();
        expect(mergedNegEvidence.filter(n => n.subject?.compound_id === 'sciweon::compound::CID:24100').length).toBe(1);
        // CID 20144 from previous (not in current cycle) also kept
        expect(mergedCompounds.find(c => c.id === 'sciweon::compound::CID:20144')).toBeDefined();

        expect(result.perFile['compounds-enriched.jsonl'].total).toBe(4);
        expect(result.perFile['neg-evidence.jsonl'].total).toBe(9);
    });

    it('retry-queue scenario: same CID failed in previous cycle, succeeded in current — current wins', async () => {
        // Previous cycle had a stub (low-quality) record for CID 15577 that failed mid-enrichment
        const stubRecord = { ...compoundRec(15577), enrichment_status: 'partial' };
        const previousBuffers: Record<string, Buffer> = {};
        for (const f of MERGE_FILES) previousBuffers[f] = Buffer.alloc(0);
        previousBuffers['compounds-enriched.jsonl'] = Buffer.from(JSON.stringify(stubRecord));

        // Current cycle re-harvested via retry queue, full record now
        const fullRecord = { ...compoundRec(15577), enrichment_status: 'complete', new_field: 'present' };
        await writeLinked('compounds-enriched.jsonl', [fullRecord]);

        await mergeLocalAggregatedWithPrevious(previousBuffers);

        const merged = await readLinked('compounds-enriched.jsonl') as any[];
        expect(merged.length).toBe(1);  // only one CID 15577
        expect(merged[0].enrichment_status).toBe('complete');  // current wins
        expect(merged[0].new_field).toBe('present');
    });
});
