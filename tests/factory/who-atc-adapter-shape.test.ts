/**
 * Cycle 21 PR #5 — WHO-ATC adapter API-shape lock.
 *
 * The adapter previously parsed `data.atc_classifications ?? data.atc_class`
 * — neither key exists in the ChEMBL response. fetchIncremental loops
 * silently produced 0 records every cron. Combined with worker cursor
 * poisoning, this blocked ATC enrichment entirely.
 *
 * Fixture captured live 2026-05-22 from
 *   GET https://www.ebi.ac.uk/chembl/api/data/atc_class.json?limit=2&offset=0
 *
 * [[feedback_local_verify_external_api]]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LIVE_RESPONSE_2026_05_22 = {
    atc: [
        {
            level1: 'A', level1_description: 'ALIMENTARY TRACT AND METABOLISM',
            level2: 'A01', level2_description: 'STOMATOLOGICAL PREPARATIONS',
            level3: 'A01A', level3_description: 'STOMATOLOGICAL PREPARATIONS',
            level4: 'A01AA', level4_description: 'Caries prophylactic agents',
            level5: 'A01AA01', who_name: 'sodium fluoride',
        },
        {
            level1: 'A', level1_description: 'ALIMENTARY TRACT AND METABOLISM',
            level2: 'A01', level2_description: 'STOMATOLOGICAL PREPARATIONS',
            level3: 'A01A', level3_description: 'STOMATOLOGICAL PREPARATIONS',
            level4: 'A01AA', level4_description: 'Caries prophylactic agents',
            level5: 'A01AA02', who_name: 'sodium monofluorophosphate',
        },
    ],
    page_meta: { limit: 2, next: null, offset: 0, previous: null, total_count: 2 },
};

describe('who-atc fetchIncremental — live API shape lock', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200,
            json: async () => LIVE_RESPONSE_2026_05_22,
        })));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('parses items under `atc` key (not atc_classifications / atc_class)', async () => {
        const { fetchIncremental } = await import('../../scripts/ingestion/adapters/who-atc-adapter.js');
        const { records } = await fetchIncremental(null);
        expect(records).toHaveLength(2);
        expect(records[0].id).toBe('sciweon::atc_class::A01AA01');
        expect(records[0].who_name).toBe('sodium fluoride');
        expect(records[1].id).toBe('sciweon::atc_class::A01AA02');
    });

    it('back-compat: legacy `atc_classifications` shape still parses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({
                atc_classifications: [{ level5: 'X99XX99', who_name: 'legacy-test' }],
                page_meta: { total_count: 1 },
            }),
        })));
        const { fetchIncremental } = await import('../../scripts/ingestion/adapters/who-atc-adapter.js');
        const { records } = await fetchIncremental(null);
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe('sciweon::atc_class::X99XX99');
    });

    it('back-compat: legacy `atc_class` shape still parses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({
                atc_class: [{ level5: 'Y88YY88', who_name: 'legacy2' }],
                page_meta: { total_count: 1 },
            }),
        })));
        const { fetchIncremental } = await import('../../scripts/ingestion/adapters/who-atc-adapter.js');
        const { records } = await fetchIncremental(null);
        expect(records).toHaveLength(1);
    });

    it('empty response yields 0 records, no crash', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({ page_meta: { total_count: 0 } }),
        })));
        const { fetchIncremental } = await import('../../scripts/ingestion/adapters/who-atc-adapter.js');
        const { records } = await fetchIncremental(null);
        expect(records).toEqual([]);
    });
});
