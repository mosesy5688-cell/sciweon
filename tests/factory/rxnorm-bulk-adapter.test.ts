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
        ], { upstream_source: 'rxnorm_full', upstream_license: 'umls' });

        const parsed = parseRxcuiIndexJsonl(jsonl);
        expect(parsed.totalRecords).toBe(2);
        expect(parsed.licenseMetadata?.upstream_source).toBe('rxnorm_full');
        expect(parsed.licenseMetadata?.upstream_license).toBe('umls');
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

    it('5a. lookupByNdc accepts HIPAA-segmented input (5-3-2 / 5-4-1 / 4-4-2) -> same Set as 11-digit form', () => {
        // PR-RXN-1b-ndc-normalize: deferred-normalization contract enforced at lookup.
        // Uses the three canonical HIPAA-padded examples baked into ndc-normalize.js JSDoc.
        // 5-3-2: "50242-040-62" -> "50242004062" (pad product 3 -> 4 via inserted "0")
        const parsed532 = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN_532', preferred_str: 'Drug-532', tty: 'IN', sab: 'RXNORM', unii: null, ndcs: ['50242004062'] },
        ]));
        const ref532 = lookupByNdc(parsed532, '50242004062');
        const seg532 = lookupByNdc(parsed532, '50242-040-62');
        expect(ref532.size).toBe(1);
        expect(seg532).toEqual(ref532);
        // 5-4-1: "12345-6789-0" -> "12345678900" (pad package 1 -> 2 via "0"
        // inserted between product and package per ndc-normalize.js
        // `labeler + product + '0' + pkg` -- note JSDoc example "12345067890"
        // is misleading; code-actual output is what RxNorm map keys hold).
        const parsed541 = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN_541', preferred_str: 'Drug-541', tty: 'IN', sab: 'RXNORM', unii: null, ndcs: ['12345678900'] },
        ]));
        const ref541 = lookupByNdc(parsed541, '12345678900');
        const seg541 = lookupByNdc(parsed541, '12345-6789-0');
        expect(ref541.size).toBe(1);
        expect(seg541).toEqual(ref541);
        // 4-4-2: "0042-0220-01" -> "00042022001" (pad labeler 4 -> 5 via prepended "0")
        const parsed442 = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN_442', preferred_str: 'Drug-442', tty: 'IN', sab: 'RXNORM', unii: null, ndcs: ['00042022001'] },
        ]));
        const ref442 = lookupByNdc(parsed442, '00042022001');
        const seg442 = lookupByNdc(parsed442, '0042-0220-01');
        expect(ref442.size).toBe(1);
        expect(seg442).toEqual(ref442);
    });

    it('5b. lookupByNdc with malformed input returns empty Set without throwing', () => {
        const parsed = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN1', preferred_str: 'X', tty: 'IN', sab: 'RXNORM', unii: 'U1', ndcs: ['00088115033'] },
        ]));
        // Non-numeric chars, wrong segment count, non-HIPAA shape -> all return empty Set
        for (const bad of ['INVALID-NDC-STRING', '00088', '00088-115', '00088-115-033-extra', 'abc-def-gh', '']) {
            const hit = lookupByNdc(parsed, bad);
            expect(hit instanceof Set).toBe(true);
            expect(hit.size).toBe(0);
        }
    });

    it('5c. PR-RXN-1d: parseRxcuiIndexJsonl canonicalizes UNII keys (uppercase + trim); lookup tolerates dirty input', () => {
        const parsed = parseRxcuiIndexJsonl(makeJsonl([
            { rxcui: 'IN_U', preferred_str: 'Naproxen', tty: 'IN', sab: 'RXNORM', unii: '  8mjb9hsc8q  ', ndcs: [] },
        ]));
        // Map key is canonical regardless of dirty source input
        expect(parsed.uniiToRxcui.has('8MJB9HSC8Q')).toBe(true);
        expect(parsed.uniiToRxcui.has('  8mjb9hsc8q  ')).toBe(false);
        // Lookup with original dirty form still hits via lookupByUnii canonicalization
        const hit = lookupByUnii(parsed, '  8mjb9hsc8q  ');
        expect(hit?.rxcui).toBe('IN_U');
        // Also lowercase-only and uppercase-clean both hit
        expect(lookupByUnii(parsed, '8mjb9hsc8q')?.rxcui).toBe('IN_U');
        expect(lookupByUnii(parsed, '8MJB9HSC8Q')?.rxcui).toBe('IN_U');
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
