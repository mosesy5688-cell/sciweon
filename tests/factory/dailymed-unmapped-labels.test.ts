// @ts-nocheck
/**
 * PR-MD-1g-probe: summarizeUnmappedLabels tests (no_rxcui=500 diagnosis).
 *
 * Locks the SAB-honest naming: a 0-hit NDC is `absent_from_accepted_sab_map`
 * (our RXNORM+MTHSPL slice), NOT absent_from_rxnorm -- the in-memory map is blind
 * to harvest-excluded commercial SABs.
 */

import { describe, it, expect } from 'vitest';
import { summarizeUnmappedLabels } from '../../scripts/factory/lib/dailymed-unmapped-labels.js';

const label = (setid, rxcui, ndcs) => ({ id: `sciweon::drug_label::${setid}`, setid, rxcui, ndcs });
// '00001000001' is in the map; '00002000002' normalizes but is absent.
const maps = { ndcToRxcuis: new Map([['00001000001', new Set([{ rxcui: 'X' }])]]) };

describe('summarizeUnmappedLabels', () => {
    it('a) no-ndc label -> no_ndc_labels, not ndcs_all_unmapped', () => {
        const r = summarizeUnmappedLabels([label('A', [], [])], maps);
        expect(r.no_rxcui_labels).toBe(1);
        expect(r.no_ndc_labels).toBe(1);
        expect(r.ndcs_all_unmapped).toBe(0);
    });

    it('b) ndcs all unmapped (normalizes, 0 hits) -> absent_from_accepted_sab_map', () => {
        const r = summarizeUnmappedLabels([label('B', [], ['00002000002'])], maps);
        expect(r.ndcs_all_unmapped).toBe(1);
        expect(r.ndc_hits_absent_from_accepted_sab).toBe(1);
        expect(r.ndc_hits_malformed).toBe(0);
        expect(r.sample_unmapped[0]).toMatchObject({ ndc: '00002000002', reason: 'absent_from_accepted_sab_map' });
    });

    it('c) NDC that does not normalize -> malformed', () => {
        const r = summarizeUnmappedLabels([label('C', [], ['notanndc'])], maps);
        expect(r.ndc_hits_malformed).toBe(1);
        expect(r.sample_unmapped[0]).toMatchObject({ ndc: 'notanndc', normalized: null, reason: 'malformed' });
    });

    it('d) NDC that DOES map on a no_rxcui label -> unexpected_mapped (anomaly surfaced)', () => {
        const r = summarizeUnmappedLabels([label('D', [], ['00001000001'])], maps);
        expect(r.ndc_hits_unexpected_mapped).toBe(1);
        expect(r.ndc_hits_absent_from_accepted_sab).toBe(0);
    });

    it('e) label WITH rxcui is not in the no_rxcui pool -> ignored', () => {
        const r = summarizeUnmappedLabels([label('E', ['999'], ['00002000002'])], maps);
        expect(r.no_rxcui_labels).toBe(0);
        expect(r.ndcs_all_unmapped).toBe(0);
    });

    it('f) fail-soft: no bulkMaps -> reverse_map_available false, label counts only', () => {
        const r = summarizeUnmappedLabels([label('F', [], ['00002000002'])], null);
        expect(r.reverse_map_available).toBe(false);
        expect(r.no_rxcui_labels).toBe(1);
        expect(r.ndcs_all_unmapped).toBe(1);
        expect(r.ndc_hits_absent_from_accepted_sab).toBe(0);  // cannot re-lookup
    });

    it('g) non-label records ignored; never throws on null input', () => {
        const r = summarizeUnmappedLabels([{ id: 'sciweon::compound::CID:1', rxcui: [] }, null], maps);
        expect(r.no_rxcui_labels).toBe(0);
    });
});
