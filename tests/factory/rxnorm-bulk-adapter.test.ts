// @ts-nocheck
/**
 * PR-RXN-1 adapter parse tests.
 *
 * Locks the JSONL header + record parse contract (license_metadata
 * header line + ingredient-keyed records) so future drift in harvester
 * output shape surfaces at adapter load time.
 */

import { describe, it, expect } from 'vitest';
import { parseRxcuiIndexJsonl, lookupByUnii, lookupByNdc } from '../../scripts/ingestion/adapters/rxnorm-bulk-adapter.js';

function makeJsonl(records, licenseMetadata) {
    const lines = [];
    if (licenseMetadata) lines.push('#' + JSON.stringify({ license_metadata: licenseMetadata }));
    for (const r of records) lines.push(JSON.stringify(r));
    return lines.join('\n') + '\n';
}

describe('PR-RXN-1: parseRxcuiIndexJsonl + lookup APIs', () => {
    it('1. parses license_metadata header + records into both Maps', () => {
        const jsonl = makeJsonl([
            { rxcui: 'IN1', preferred_str: 'Drug-A', tty: 'IN', sab: 'RXNORM', unii: 'AAA000', ndcs: ['00071015523'] },
            { rxcui: 'IN2', preferred_str: 'Drug-B', tty: 'IN', sab: 'RXNORM', unii: 'BBB000', ndcs: ['12345678901', '99999999999'] },
        ], { upstream_source: 'rxnorm_prescribable', upstream_license: 'public-domain' });

        const parsed = parseRxcuiIndexJsonl(jsonl);
        expect(parsed.totalRecords).toBe(2);
        expect(parsed.licenseMetadata?.upstream_source).toBe('rxnorm_prescribable');
        expect(parsed.uniiToRxcui.size).toBe(2);
        expect(parsed.ndcToRxcuis.size).toBe(3);
    });

    it('2. lookupByUnii returns ingredient meta on hit', () => {
        const parsed = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN1', preferred_str: 'X', tty: 'IN', sab: 'RXNORM', unii: 'U1', ndcs: [] },
        ]));
        const hit = lookupByUnii(parsed, 'U1');
        expect(hit?.rxcui).toBe('IN1');
        expect(hit?.preferred_str).toBe('X');
        expect(lookupByUnii(parsed, 'MISS')).toBe(null);
    });

    it('3. lookupByNdc returns Set (combination-product 1:N safe)', () => {
        // Two ingredient records sharing a single NDC (combination drug).
        const parsed = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN_A', preferred_str: 'Ipratropium', tty: 'IN', sab: 'RXNORM', unii: null, ndcs: ['00088115033'] },
            { rxcui: 'IN_B', preferred_str: 'Albuterol', tty: 'IN', sab: 'RXNORM', unii: null, ndcs: ['00088115033'] },
        ]));
        const hit = lookupByNdc(parsed, '00088115033');
        expect(hit instanceof Set).toBe(true);
        expect(hit.size).toBe(2);
        const rxcuis = [...hit].map(m => m.rxcui).sort();
        expect(rxcuis).toEqual(['IN_A', 'IN_B']);
    });

    it('4. lookupByNdc miss returns empty Set (not null) so callers iterate safely', () => {
        const parsed = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN1', preferred_str: 'X', tty: 'IN', sab: 'RXNORM', unii: 'U1', ndcs: [] },
        ]));
        const hit = lookupByNdc(parsed, '00000000000');
        expect(hit instanceof Set).toBe(true);
        expect(hit.size).toBe(0);
    });

    it('5. malformed lines skipped without throwing; valid records still indexed', () => {
        const jsonl = [
            '#{"license_metadata":{"upstream_source":"rxnorm_prescribable"}}',
            'not-json-at-all',
            JSON.stringify({ rxcui: 'IN1', preferred_str: 'X', tty: 'IN', sab: 'RXNORM', unii: 'U1', ndcs: [] }),
            '',
        ].join('\n');
        const parsed = parseRxcuiIndexJsonl(jsonl);
        expect(parsed.totalRecords).toBe(1);
        expect(parsed.uniiToRxcui.size).toBe(1);
    });
});
