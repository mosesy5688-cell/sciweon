// @ts-nocheck
/**
 * PR-2 F1-harvest batch migration -- getCompoundsBatch core (zero-loss lock, part 1).
 *
 * The runBatchPass2 / no-loss-invariant integration lives in the sibling
 * pubchem-batch-pass2.test.ts (split per the Art 5.1 250-line cap). This file
 * locks the adapter primitive getCompoundsBatch (network-free via the deps seam;
 * the single-CID reference path stubs the global fetch):
 *   1. IDENTITY: batch == single-CID, byte-identical (incl. non-empty synonyms)
 *      after masking the 2 ISO timestamps -> normalize is the sole constructor.
 *   2. DEAD-CID A (200-with-omission): an omitted CID -> noRecord.
 *   3. DEAD-CID B (4xx-then-bisect): a whole-chunk 400 bisects to the single
 *      404 dead CID; ALL live siblings survive (zero lost).
 *   4. SYNONYMS non-fatal: a synonyms 5xx exhaustion -> [] synonyms, properties intact.
 *   8. DETERMINISM: dup CID -> first-wins; shuffled props -> ascending output +
 *      correct synonym join; two runs -> identical jsonl (timestamps masked).
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { setMode, MODE_REJECT } from '../../scripts/factory/lib/validation-gate.js';
import { getCompoundsBatch } from '../../scripts/factory/lib/pubchem-batch.js';
import { getCompound } from '../../scripts/ingestion/adapters/pubchem-adapter.js';
import { rawFor, synFor, maskTs, makeResponse, makeDeps } from './helpers/pubchem-batch-fixtures.js';

beforeAll(() => setMode(MODE_REJECT));
afterEach(() => { vi.unstubAllGlobals(); });

const deps = (propsFn, synsFn) => makeDeps(propsFn, synsFn, vi.fn);

// ── 1. IDENTITY ───────────────────────────────────────────────────────────
describe('1. IDENTITY — batch == single-CID, byte-identical (timestamps masked)', () => {
    it('same fixtures via getCompound (single) and getCompoundsBatch (batch) -> equal entities + non-empty synonyms', async () => {
        const cids = [2244, 3672, 5090];

        // Reference: single-CID path. getCompound issues 2 GETs per CID
        // (property + synonyms); route by URL.
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const cid = Number(url.match(/cid\/(\d+)\//)[1]);
            if (url.includes('/synonyms/')) {
                return makeResponse(200, { InformationList: { Information: [{ CID: cid, Synonym: synFor(cid) }] } });
            }
            return makeResponse(200, { PropertyTable: { Properties: [rawFor(cid)] } });
        }));
        const single: Record<string, any> = {};
        for (const c of cids) single[c] = await getCompound(c);

        // Batch path.
        const res = await getCompoundsBatch(cids, deps((cs: number[]) => cs.map(c => rawFor(c))));

        for (const c of cids) {
            const s = single[c];
            const b = res.entitiesByCid.get(String(c));
            expect(b).toBeTruthy();
            // Byte-identical after masking the 2 ISO timestamps.
            expect(JSON.stringify(maskTs(b))).toBe(JSON.stringify(maskTs(s)));
            // Synonyms populated (non-empty) on BOTH.
            expect(b.synonyms.length).toBeGreaterThan(0);
            expect(s.synonyms).toEqual(b.synonyms);
        }
        expect(res.noRecord).toEqual([]);
    });
});

// ── 2. DEAD-CID A: 200-with-omission ──────────────────────────────────────
describe('2. DEAD-CID A — 200 omits a CID -> noRecord (requested-minus-returned diff)', () => {
    it('props 200 returns only live CIDs; the omitted CID lands in noRecord', async () => {
        const res = await getCompoundsBatch([10, 11, 12],
            deps((cs: number[]) => cs.filter(c => c !== 11).map(c => rawFor(c))));
        expect(res.entitiesByCid.has('10')).toBe(true);
        expect(res.entitiesByCid.has('12')).toBe(true);
        expect(res.noRecord).toEqual(['11']);
    });
});

// ── 3. DEAD-CID B: 4xx-then-bisect-to-404 ─────────────────────────────────
describe('3. DEAD-CID B — whole-chunk 400 bisects to the single dead CID; siblings survive', () => {
    it('the chunk 400s iff the dead CID is present; bisect isolates it, all live -> entities (zero lost)', async () => {
        const cids = [20, 21, 22, 23]; // 22 is the dead CID
        const propsFn = (cs: number[]) => {
            // 4xx the WHOLE request whenever the dead CID is in it (poison-style 400),
            // down to the single-CID request where it 4xxs alone.
            if (cs.includes(22)) throw new Error(`HTTP 400: https://pubchem/post?cid=${cs.join(',')}`);
            return cs.map(c => rawFor(c));
        };
        const res = await getCompoundsBatch(cids, deps(propsFn));
        for (const c of [20, 21, 23]) expect(res.entitiesByCid.has(String(c))).toBe(true);
        expect(res.noRecord).toEqual(['22']);
        expect(res.entitiesByCid.size).toBe(3);
    });

    it('a single-CID clean 4xx isolates to noRecord (never re-batched)', async () => {
        const res = await getCompoundsBatch([404404],
            deps(() => { throw new Error('HTTP 404: https://pubchem/post?cid=404404'); }));
        expect(res.entitiesByCid.size).toBe(0);
        expect(res.noRecord).toEqual(['404404']);
    });
});

// ── 4. SYNONYMS non-fatal ─────────────────────────────────────────────────
describe('4. SYNONYMS non-fatal — a synonyms 5xx exhaustion -> [] synonyms, properties intact', () => {
    it('synonyms leg throws -> entities still built with [] synonyms (visible, not silent zero)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = makeDeps((cs: number[]) => cs.map(c => rawFor(c)),
            () => { throw new Error('HTTP 500: synonyms exhausted (attempt 3/3)'); });
        const res = await getCompoundsBatch([40, 41], d);
        expect(res.entitiesByCid.size).toBe(2);             // properties unaffected
        expect(res.entitiesByCid.get('40').synonyms).toEqual([]); // [] fallback
        expect(res.noRecord).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/synonyms batch failed \(non-fatal/));
        warn.mockRestore();
    });
});

// ── 8. DETERMINISM ────────────────────────────────────────────────────────
describe('8. DETERMINISM — first-wins on dup; shuffled props -> ascending output + correct synonym join', () => {
    it('duplicate CID in returned props -> FIRST-WINS', async () => {
        const res = await getCompoundsBatch([90, 91], deps(() => [
            rawFor(90, { IUPACName: 'first-90' }),
            rawFor(90, { IUPACName: 'second-90' }), // dup -> ignored (first-wins)
            rawFor(91),
        ]));
        expect(res.entitiesByCid.get('90').iupac_name).toBe('first-90');
        expect(res.entitiesByCid.size).toBe(2);
    });

    it('props returned in SHUFFLED order -> entities still ascending + correct synonym join', async () => {
        const cids = [100, 101, 102, 103];
        const res = await getCompoundsBatch(cids,
            deps(() => [rawFor(102), rawFor(100), rawFor(103), rawFor(101)],
                (cs: number[]) => new Map(cs.map(c => [String(c), synFor(c)]))));
        // Map iteration order == insertion order == the requested (ascending) order.
        expect([...res.entitiesByCid.keys()]).toEqual(['100', '101', '102', '103']);
        for (const c of cids) expect(res.entitiesByCid.get(String(c)).synonyms).toEqual(synFor(c));
    });

    it('two runs over the same fixture -> identical jsonl (timestamps masked)', async () => {
        const cids = [110, 111, 112];
        const run = async () => {
            const res = await getCompoundsBatch(cids, deps(() => cids.map(c => rawFor(c))));
            return cids.map(c => JSON.stringify(maskTs(res.entitiesByCid.get(String(c))))).join('\n');
        };
        expect(await run()).toBe(await run());
    });
});
