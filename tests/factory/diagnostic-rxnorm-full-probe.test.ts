// @ts-nocheck
/**
 * PR-RXN-2a: tests for the Full RRF diagnostic pure classifier.
 *
 * classifyRxnsatUniiRow is the column-boundary-safe oracle for RXNSAT UNII
 * extraction. Locked so the diagnostic + the eventual harvester gate cannot
 * drift, and so ATN!='UNII' rows are never mistaken for UNII even when their
 * ATV happens to be UNII-shaped (the column-order trap from PR-RXN-1).
 */

import { describe, it, expect } from 'vitest';
import { classifyRxnsatUniiRow } from '../../scripts/factory/diagnostic-rxnorm-full-probe.js';

describe('classifyRxnsatUniiRow', () => {
    it('ATN=UNII + canonical 10-char ATV -> is_unii_attr + unii_shape', () => {
        const r = classifyRxnsatUniiRow({ ATN: 'UNII', SAB: 'RXNORM', ATV: '362O9ITL9D', RXCUI: '161' });
        expect(r).toEqual({ is_unii_attr: true, unii_shape: true, unii: '362O9ITL9D' });
    });

    it('ATN=UNII + lowercase ATV -> canonicalized (trim+upper) to a shape match', () => {
        const r = classifyRxnsatUniiRow({ ATN: 'UNII', ATV: ' 362o9itl9d ' });
        expect(r.is_unii_attr).toBe(true);
        expect(r.unii_shape).toBe(true);
        expect(r.unii).toBe('362O9ITL9D');
    });

    it('ATN=UNII + wrong-length ATV -> unii_shape false (still flagged as the attr)', () => {
        expect(classifyRxnsatUniiRow({ ATN: 'UNII', ATV: 'TOOSHORT' }).unii_shape).toBe(false);
        expect(classifyRxnsatUniiRow({ ATN: 'UNII', ATV: '362O9ITL9D1' }).unii_shape).toBe(false);
    });

    it('ATN!=UNII never counts as UNII even when ATV is UNII-shaped (column-trap guard)', () => {
        const r = classifyRxnsatUniiRow({ ATN: 'NDC', ATV: '362O9ITL9D' });
        expect(r.is_unii_attr).toBe(false);
        expect(r.unii_shape).toBe(false);
    });

    it('missing / non-object input -> both false, no throw', () => {
        expect(classifyRxnsatUniiRow(null)).toEqual({ is_unii_attr: false, unii_shape: false, unii: '' });
        expect(classifyRxnsatUniiRow({})).toEqual({ is_unii_attr: false, unii_shape: false, unii: '' });
        expect(classifyRxnsatUniiRow({ ATN: 'UNII', ATV: 12345 }).unii_shape).toBe(false);
    });
});
