// @ts-nocheck
/**
 * PR-T1.1a R5: neg-builders-fda boxed_warnings[] (per-element distinct id +
 * fallback read + LOUD one-but-not-other count) + the reason_text unslice.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    buildFdaSignals, boxedWarningStats, resetBoxedWarningStats,
} from '../../scripts/factory/lib/neg-builders-fda.js';

function compoundWith(fdaSignals) {
    return { id: 'sciweon::compound::CID:5002', external_ids: { unii: 'U1' }, fda_signals: fdaSignals };
}

function boxedRecords(compounds) {
    return [...buildFdaSignals(compounds)].filter(r => r.evidence_type === 'black_box_warning');
}

beforeEach(() => resetBoxedWarningStats());

describe('R5 boxed_warnings[] -> one NegEvidence per warning, distinct ids', () => {
    it('N warnings -> N records with DISTINCT ids (no 1-of-N collision)', () => {
        const recs = boxedRecords([compoundWith({
            has_boxed_warning: true,
            boxed_warnings: [{ text: 'Hepatotoxicity warning' }, { text: 'QT prolongation warning' }, { text: 'Embryo-fetal toxicity' }],
            boxed_warning_text: 'Hepatotoxicity warning',
        })]);
        expect(recs.length).toBe(3);
        const ids = recs.map(r => r.id);
        expect(new Set(ids).size).toBe(3);   // all distinct (today they collide to 1)
        for (const id of ids) expect(id.startsWith('sciweon::neg::boxed::CID:5002')).toBe(true);
        // full text preserved (no slice to 4000).
        expect(recs.map(r => r.failure.reason_text)).toEqual([
            'Hepatotoxicity warning', 'QT prolongation warning', 'Embryo-fetal toxicity',
        ]);
        expect(boxedWarningStats.migratedArray).toBe(1);
        expect(boxedWarningStats.legacyFallback).toBe(0);
    });

    it('reason_text NOT sliced to 4000 (the 40000 schema cap bounds it)', () => {
        const big = 'x'.repeat(8000);
        const recs = boxedRecords([compoundWith({ has_boxed_warning: true, boxed_warnings: [{ text: big }] })]);
        expect(recs[0].failure.reason_text.length).toBe(8000);
    });

    it('FALLBACK: un-migrated record (no boxed_warnings[]) uses single boxed_warning_text', () => {
        const recs = boxedRecords([compoundWith({ has_boxed_warning: true, boxed_warning_text: 'Legacy single warning' })]);
        expect(recs.length).toBe(1);
        expect(recs[0].id).toBe('sciweon::neg::boxed::CID:5002');   // no per-element suffix
        expect(recs[0].failure.reason_text).toBe('Legacy single warning');
        expect(boxedWarningStats.legacyFallback).toBe(1);
        expect(boxedWarningStats.migratedArray).toBe(0);
    });

    it('LOUD one-but-not-other: array present but no text -> arrayButNoText counted', () => {
        boxedRecords([compoundWith({ has_boxed_warning: true, boxed_warnings: [{ text: 'W1' }] })]);
        expect(boxedWarningStats.arrayButNoText).toBe(1);
    });

    it('no boxed warning at all -> no records, no counts', () => {
        const recs = boxedRecords([compoundWith({ has_boxed_warning: false })]);
        expect(recs.length).toBe(0);
        expect(boxedWarningStats.migratedArray).toBe(0);
        expect(boxedWarningStats.legacyFallback).toBe(0);
    });

    it('empty-string warning items are skipped (no empty NegEvidence)', () => {
        const recs = boxedRecords([compoundWith({
            has_boxed_warning: true, boxed_warnings: [{ text: 'Valid' }, { text: '' }, { text: 'Also valid' }],
        })]);
        expect(recs.length).toBe(2);
    });
});
