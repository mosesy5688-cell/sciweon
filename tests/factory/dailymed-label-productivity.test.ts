// @ts-nocheck
/**
 * PR-MD-1e: summarizeLabelProductivity tests (resolve GUARD 1).
 *
 * Locks the F3-side LABEL-level harm metric. The decisive case is (b): a multi-NDC
 * label with ONE productive rxcui links even if a sibling rxcui stranded -- proving
 * NDC-level lost is an UPPER BOUND on label harm. (c2)+(d2) lock the (B) null-tty
 * split + the (Note 1) deterministic precedence that prevents mis-scoping PR-MD-1f.
 */

import { describe, it, expect } from 'vitest';
import { summarizeLabelProductivity } from '../../scripts/factory/lib/dailymed-label-productivity.js';

const label = (setid, rxcui) => ({ id: `sciweon::drug_label::${setid}`, setid, rxcui });
// rxcuiClass: Map<rxcui, {bucket, tty}>
const cls = (entries: [string, string, string | null][]) =>
    new Map(entries.map(([r, bucket, tty]) => [r, { bucket, tty }]));

describe('summarizeLabelProductivity', () => {
    it('a) label with 1 productive rxcui -> labels_linked', () => {
        const r = summarizeLabelProductivity(
            [label('A', ['100'])], new Set(['100']), cls([['100', 'productive', 'SCD']]));
        expect(r.labels_linked).toBe(1);
        expect(r.labels_zero_productive).toBe(0);
        expect(r.total_labels_with_rxcui).toBe(1);
    });

    it('b) DECISIVE multi-NDC: one productive + one no_unii_bridge -> linked, NOT harmed', () => {
        const r = summarizeLabelProductivity(
            [label('B', ['100', '999'])], new Set(['100']),
            cls([['100', 'productive', 'SCD'], ['999', 'no_unii_bridge', null]]));
        expect(r.labels_linked).toBe(1);
        expect(r.labels_zero_productive).toBe(0);
    });

    it('c) all rxcui no_unii_bridge with non-null tty -> projection_gap_typed', () => {
        const r = summarizeLabelProductivity(
            [label('C', ['777'])], new Set(),
            cls([['777', 'no_unii_bridge', 'GPCK']]));
        expect(r.labels_zero_productive).toBe(1);
        expect(r.harm_reason.projection_gap_typed).toBe(1);
        expect(r.harm_reason.projection_gap_null_tty).toBe(0);
        expect(r.samples.zero_productive[0]).toMatchObject({
            setid: 'C', reason: 'projection_gap_typed',
        });
        expect(r.samples.zero_productive[0].rxcui[0]).toMatchObject({ rxcui: '777', bucket: 'no_unii_bridge', tty: 'GPCK' });
    });

    it('c2) all rxcui no_unii_bridge with tty=null -> projection_gap_null_tty (RXNREL-ineffective)', () => {
        const r = summarizeLabelProductivity(
            [label('C2', ['888'])], new Set(),
            cls([['888', 'no_unii_bridge', null]]));
        expect(r.labels_zero_productive).toBe(1);
        expect(r.harm_reason.projection_gap_null_tty).toBe(1);
        expect(r.harm_reason.projection_gap_typed).toBe(0);
    });

    it('d) label rxcui not_in_corpus -> zero_productive, reason not_in_corpus', () => {
        const r = summarizeLabelProductivity(
            [label('D', ['555'])], new Set(),
            cls([['555', 'not_in_corpus', null]]));
        expect(r.labels_zero_productive).toBe(1);
        expect(r.harm_reason.not_in_corpus).toBe(1);
    });

    it('d2) PRECEDENCE: null_tty + not_in_corpus -> null_tty wins, order-independent', () => {
        const forward = summarizeLabelProductivity(
            [label('D2', ['888', '555'])], new Set(),
            cls([['888', 'no_unii_bridge', null], ['555', 'not_in_corpus', null]]));
        const reversed = summarizeLabelProductivity(
            [label('D2', ['555', '888'])], new Set(),
            cls([['888', 'no_unii_bridge', null], ['555', 'not_in_corpus', null]]));
        expect(forward.harm_reason.projection_gap_null_tty).toBe(1);
        expect(forward.harm_reason.not_in_corpus).toBe(0);
        expect(reversed.harm_reason.projection_gap_null_tty).toBe(1);
        expect(reversed.harm_reason.not_in_corpus).toBe(0);
    });

    it('e) label with empty rxcui[] -> labels_no_rxcui, not counted as harm', () => {
        const r = summarizeLabelProductivity([label('E', [])], new Set(), new Map());
        expect(r.labels_no_rxcui).toBe(1);
        expect(r.total_labels_with_rxcui).toBe(0);
        expect(r.labels_zero_productive).toBe(0);
    });

    it('f) fail-soft: empty rxcuiClass -> core counts correct, reason mixed_or_other', () => {
        const r = summarizeLabelProductivity(
            [label('F1', ['100']), label('F2', ['999'])], new Set(['100']), new Map());
        expect(r.labels_linked).toBe(1);           // F1 via compoundRxcui
        expect(r.labels_zero_productive).toBe(1);  // F2, no class info
        expect(r.harm_reason.mixed_or_other).toBe(1);
    });

    it('g) non-label records and null input are ignored (never throws)', () => {
        const r = summarizeLabelProductivity(
            [{ id: 'sciweon::compound::CID:1', rxcui: ['100'] }, null], new Set(), new Map());
        expect(r.total_labels_with_rxcui).toBe(0);
        expect(r.labels_no_rxcui).toBe(0);
    });
});
