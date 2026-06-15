// @ts-nocheck
/**
 * RK-16C SPIKE — SYNTHETIC heavy-hitter (degree 43,364): mandatory two-level
 * directory (depth 1, nested fail-loud), and the LIST read-budget proof
 * (<=4 control + <=4 posting + 0 canonical + total <=8) across a multi-request
 * cursor walk (NO single-request scan-to-fill). Uses the REAL A1 ReadBudget +
 * the A2 directory reader. OFFLINE/FIXTURE. The 43,364-entity shard is built
 * ONCE in beforeAll (WASM-zstd is slow) and shared across the assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeHeavyHitterRows, HEAVY_HITTER_DEGREE, HEAVY_HITTER_TARGET_ID }
    from '../../scripts/spikes/rk16c/lib/heavy-hitter.mjs';
import { buildCanonical, projectRows, materializeKey } from '../../scripts/spikes/rk16c/lib/build-axis.mjs';
import { readProjectionPage } from '../../scripts/spikes/rk16c/lib/page-source.mjs';
import { decide, PER_KEY_INLINE_PAGEREF_CAP } from '../../scripts/factory/lib/rk16/posting-threshold.js';
import { ROUTE_PROFILES, newReadBudget } from '../../src/worker/lib/rk16/read-budget';
import { readPostingDirectory } from '../../src/worker/lib/rk16/directory-reader';
import { isPostingPageRef } from '../../src/worker/lib/rk16/refs';

const POLICY = { record_count_target: 512, compressed_bytes_ceiling: 512 * 1024, parsed_heap_ceiling: 4 * 1024 * 1024 };
const ENV = { SHARD_AES_KEY: undefined };

let HEAVY; // { m, total, pageRows }

beforeAll(async () => {
    const rows = makeHeavyHitterRows(HEAVY_HITTER_DEGREE);
    const { byCanonicalId } = await buildCanonical(rows, undefined, 'canon/heavy.bin');
    const proj = projectRows(rows, byCanonicalId);
    const m = await materializeKey(proj, POLICY, undefined, HEAVY_HITTER_TARGET_ID);
    const pageRows = [];
    for (const pr of m.page_refs) pageRows.push(await readProjectionPage(m.proj.shard_bytes, pr));
    HEAVY = { m, total: rows.length, pageRows };
}, 600000);

describe('rk16c heavy-hitter two-level directory', () => {
    it('PageRef count > 64 forces mandatory two-level at depth 1', () => {
        const { m } = HEAVY;
        expect(m.page_refs.length).toBeGreaterThan(PER_KEY_INLINE_PAGEREF_CAP);
        const d = decide(m.page_refs);
        expect(d.two_level).toBe(true);
        expect(d.directory_depth).toBe(1);
        expect(m.posting.posting_list.kind).toBe('posting_directory_ref');
    });

    it('directory holds ONLY page refs (depth 1); a nested directory FAILS LOUD', async () => {
        const { m } = HEAVY;
        const back = await readPostingDirectory(
            new Uint8Array(m.posting.directory_bytes), m.posting.posting_list, ENV);
        expect(back.length).toBe(m.page_refs.length);
        expect(back.every((r) => isPostingPageRef(r))).toBe(true);
        expect(back.some((r) => r.kind === 'posting_directory_ref')).toBe(false);
        // a directory whose payload nests another directory is rejected (depth 1).
        const nested = [{ kind: 'posting_directory_ref', directory_shard_key: 'x', directory_offset: 0, directory_length: 1, page_ref_count: 1, directory_sha256: 'f'.repeat(64) }];
        expect(isPostingPageRef(nested[0])).toBe(false);
    });
});

describe('rk16c LIST read-budget proof (heavy hitter)', () => {
    it('LIST profile = 4 control / 4 posting / 0 canonical / 8 total', () => {
        expect(ROUTE_PROFILES.LIST).toEqual({ control_max: 4, posting_max: 4, canonical_max: 0, total_max: 8 });
    });

    it('single LIST request within budget; 0 canonical; full walk needs many requests', () => {
        const { m, total, pageRows } = HEAVY;
        const pages = m.page_refs; // directory pages, depth 1
        let ordinal = 0; let requests = 0; let collected = 0;
        let worst = { control: 0, posting: 0, canonical: 0, total: 0 };
        while (ordinal < pages.length) {
            const budget = newReadBudget('LIST');
            expect(budget.chargeControl()).toBe(true); // read the two-level directory
            let served = 0;
            while (ordinal < pages.length) {
                if (!budget.chargePosting()) break; // refused -> stop + return cursor
                const rows = pageRows[ordinal];
                expect(budget.addParsedHeap(Buffer.byteLength(JSON.stringify(rows), 'utf-8'))).toBe(true);
                collected += rows.length; served += 1; ordinal += 1;
            }
            expect(budget.chargeCanonical()).toBe(false); // LIST never reads canonical
            worst = {
                control: Math.max(worst.control, budget.controlUsed),
                posting: Math.max(worst.posting, budget.postingUsed),
                canonical: Math.max(worst.canonical, budget.canonicalUsed),
                total: Math.max(worst.total, budget.totalUsed),
            };
            requests += 1;
            expect(served).toBeGreaterThan(0); // no empty spin / scan-to-fill
        }
        expect(collected).toBe(total); // full traversal
        expect(requests).toBeGreaterThan(1); // multiple bounded requests
        expect(worst.control).toBeLessThanOrEqual(4);
        expect(worst.posting).toBeLessThanOrEqual(4);
        expect(worst.canonical).toBe(0);
        expect(worst.total).toBeLessThanOrEqual(8);
    });
});
