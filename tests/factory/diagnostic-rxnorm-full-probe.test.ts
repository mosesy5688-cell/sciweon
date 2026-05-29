// @ts-nocheck
/**
 * PR-RXN-2a-2: tests for the Full RRF diagnostic pure classifier.
 *
 * classifyMthsplConsoRow is the column-boundary-safe oracle for the corrected
 * UNII source (RXNCONSO SAB='MTHSPL' TTY='SU' CODE -- PR-RXN-1f axis). Locked so
 * the diagnostic + the eventual harvester gate cannot drift, and so a non-MTHSPL/SU
 * row is never mistaken for UNII even when its CODE happens to be UNII-shaped.
 */

import { describe, it, expect } from 'vitest';
import { classifyMthsplConsoRow } from '../../scripts/factory/diagnostic-rxnorm-full-probe.js';

describe('classifyMthsplConsoRow', () => {
    it('SAB=MTHSPL TTY=SU + canonical CODE -> is_mthspl_su + unii_shape', () => {
        const r = classifyMthsplConsoRow({ SAB: 'MTHSPL', TTY: 'SU', CODE: '362O9ITL9D', RXCUI: '161' });
        expect(r).toEqual({ is_mthspl_su: true, unii_shape: true, unii: '362O9ITL9D' });
    });

    it('SAB=MTHSPL TTY=SU + lowercase/padded CODE -> canonicalized to a shape match', () => {
        const r = classifyMthsplConsoRow({ SAB: 'MTHSPL', TTY: 'SU', CODE: ' 362o9itl9d ' });
        expect(r.is_mthspl_su).toBe(true);
        expect(r.unii_shape).toBe(true);
        expect(r.unii).toBe('362O9ITL9D');
    });

    it('SAB=MTHSPL TTY=SU + wrong-length CODE -> unii_shape false', () => {
        expect(classifyMthsplConsoRow({ SAB: 'MTHSPL', TTY: 'SU', CODE: 'TOOSHORT' }).unii_shape).toBe(false);
        expect(classifyMthsplConsoRow({ SAB: 'MTHSPL', TTY: 'SU', CODE: '362O9ITL9D1' }).unii_shape).toBe(false);
    });

    it('MTHSPL but TTY!=SU never counts as UNII even with UNII-shaped CODE (trap guard)', () => {
        const r = classifyMthsplConsoRow({ SAB: 'MTHSPL', TTY: 'SCD', CODE: '362O9ITL9D' });
        expect(r.is_mthspl_su).toBe(false);
        expect(r.unii_shape).toBe(false);
    });

    it('non-MTHSPL SAB never counts as UNII even with UNII-shaped CODE (trap guard)', () => {
        const r = classifyMthsplConsoRow({ SAB: 'RXNORM', TTY: 'SU', CODE: '362O9ITL9D' });
        expect(r.is_mthspl_su).toBe(false);
        expect(r.unii_shape).toBe(false);
    });

    it('missing / non-object input -> both false, no throw', () => {
        expect(classifyMthsplConsoRow(null)).toEqual({ is_mthspl_su: false, unii_shape: false, unii: '' });
        expect(classifyMthsplConsoRow({})).toEqual({ is_mthspl_su: false, unii_shape: false, unii: '' });
        expect(classifyMthsplConsoRow({ SAB: 'MTHSPL', TTY: 'SU', CODE: 12345 }).unii_shape).toBe(false);
    });
});
