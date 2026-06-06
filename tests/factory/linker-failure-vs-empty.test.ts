// @ts-nocheck
/**
 * Tests for the PR-B failure-vs-empty stamp fix (the blocking-bug remediation).
 *
 * THE BUG: PR-B stamped a freshness timestamp for EVERY compound the linker
 * "queried", but the adapters swallow a fetch error as an empty array -- so a
 * transient CT.gov / OpenAlex error (429 / 5xx / timeout / outage) was
 * indistinguishable from a genuine 0-results and got stamped FRESH, skipping the
 * compound for the whole 30/45d window. A swallowed transient error that used to
 * be "retried next run" became "stuck for the whole freshness window" -- a
 * [[cross_cycle_silent_data_loss]] PR-B itself introduced.
 *
 * THE FIX (proven here at two layers):
 *   1. Adapters: searchByInterventionChecked / searchChecked return { ok, ... }.
 *      ok:false on a CAUGHT fetch error; ok:true on HTTP 200 (even 0 results).
 *   2. runCoverageStage: a fetch-failed compound is NOT in queriedIds (stays
 *      un-stamped -> eligible next run), is COUNTED in a loud query_error_count,
 *      and a TOTAL outage (queriedIds=[]) makes assertCoverageProgress THROW.
 *
 * R2 IO (readStamps/writeStamps, readCursor/writeCursor) is mocked so the real
 * stamp-merge + coverage-invariant path runs without network. The pure
 * chunkIterator / buildNextCursor / freshness predicates are NOT mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory R2 stand-ins (shared across the run-loop below).
const fakeStampStore = new Map<string, Map<string, string>>();
const fakeCursorStore = new Map<string, any>();

vi.mock('../../scripts/factory/lib/linker-stamp-store.js', () => ({
    readStamps: vi.fn(async (source: string) => new Map(fakeStampStore.get(source) ?? new Map())),
    writeStamps: vi.fn(async (source: string, map: Map<string, string>) => { fakeStampStore.set(source, new Map(map)); }),
}));

vi.mock('../../scripts/factory/lib/enrichment-cursor.js', async () => {
    const actual: any = await vi.importActual('../../scripts/factory/lib/enrichment-cursor.js');
    return {
        ...actual,
        readCursor: vi.fn(async (source: string) => fakeCursorStore.get(source) ?? null),
        writeCursor: vi.fn(async (source: string, cursor: any) => { fakeCursorStore.set(source, cursor); }),
    };
});

import { runCoverageStage } from '../../scripts/factory/lib/linker-coverage-runner.js';
import {
    TRIALS_STAMP_FIELD, isEligibleForQuery, DEFAULT_TRIALS_FRESHNESS_DAYS,
} from '../../scripts/factory/lib/linker-coverage.js';
import { searchByInterventionChecked } from '../../scripts/ingestion/adapters/clinicaltrials-adapter.js';
import { searchChecked } from '../../scripts/ingestion/adapters/openalex-adapter.js';

const NOW = Date.parse('2026-06-05T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const SOURCE = 'trial_linker_test';

function corpus(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `sciweon::compound::CID:${String(i).padStart(4, '0')}` }));
}

beforeEach(() => {
    fakeStampStore.clear();
    fakeCursorStore.clear();
});

describe('runCoverageStage: failure-vs-empty stamp logic', () => {
    it('a FAILED query (ok:false) -> compound NOT in queriedIds -> NOT stamped -> stays eligible next run', async () => {
        const compounds = corpus(2);
        // queryChunk simulates: compound[0] FAILED (fetch error), compound[1] genuine-empty (ok, 0 results).
        const queryChunk = vi.fn(async (slice: any[]) => {
            const queriedIds: string[] = [];
            let queryErrorCount = 0;
            for (const c of slice) {
                if (c.id === compounds[0].id) { queryErrorCount++; continue; } // failure -> not pushed
                queriedIds.push(c.id); // genuine-empty still pushes
            }
            return { queriedIds, queryErrorCount };
        });

        const res = await runCoverageStage({
            label: 'TRIAL-LINKER', source: SOURCE, stampField: TRIALS_STAMP_FIELD,
            freshnessDays: DEFAULT_TRIALS_FRESHNESS_DAYS, chunkSizeOverride: 50,
            compounds: corpus(2), nowMs: NOW, nowIso: NOW_ISO, queryChunk,
        });

        // Only the genuine-empty compound got stamped.
        const stamps = fakeStampStore.get(SOURCE)!;
        expect(stamps.has(compounds[1].id)).toBe(true);
        expect(stamps.has(compounds[0].id)).toBe(false); // FAILED -> un-stamped
        expect(res.queryErrorCount).toBe(1);

        // Re-derive eligibility from the persisted stamps: the failed one is STILL eligible.
        const reload = corpus(2);
        for (const c of reload) { const s = stamps.get(c.id); if (s) c.linkage = { [TRIALS_STAMP_FIELD]: s }; }
        expect(isEligibleForQuery(reload[0], TRIALS_STAMP_FIELD, DEFAULT_TRIALS_FRESHNESS_DAYS, NOW)).toBe(true);
        expect(isEligibleForQuery(reload[1], TRIALS_STAMP_FIELD, DEFAULT_TRIALS_FRESHNESS_DAYS, NOW)).toBe(false);
    });

    it('a GENUINE-empty (ok:true, 0 results) IS stamped -> not eligible (no infinite re-query)', async () => {
        const compounds = corpus(1);
        const queryChunk = vi.fn(async (slice: any[]) => ({ queriedIds: slice.map(c => c.id), queryErrorCount: 0 }));
        await runCoverageStage({
            label: 'TRIAL-LINKER', source: SOURCE, stampField: TRIALS_STAMP_FIELD,
            freshnessDays: DEFAULT_TRIALS_FRESHNESS_DAYS, chunkSizeOverride: 50,
            compounds, nowMs: NOW, nowIso: NOW_ISO, queryChunk,
        });
        const stamps = fakeStampStore.get(SOURCE)!;
        expect(stamps.get(corpus(1)[0].id)).toBe(NOW_ISO);
        const reload = corpus(1);
        reload[0].linkage = { [TRIALS_STAMP_FIELD]: stamps.get(reload[0].id) };
        expect(isEligibleForQuery(reload[0], TRIALS_STAMP_FIELD, DEFAULT_TRIALS_FRESHNESS_DAYS, NOW)).toBe(false);
    });

    it('PR-1: a TOTAL outage (all compounds ok:false, queryErrorCount>0) -> non-fatal DEGRADE (no throw)', async () => {
        // Was "THROWS"; PR-1 decouples a 3rd-party outage from an F3 abort: runCoverageStage
        // RESOLVES with degraded:true + queriedCount:0, and NEITHER the stamp store NOR the
        // cursor store is mutated (chunk stays eligible, retried next run -> no-silent-loss).
        const queryChunk = vi.fn(async (slice: any[]) => ({ queriedIds: [], queryErrorCount: slice.length }));
        const res = await runCoverageStage({
            label: 'TRIAL-LINKER', source: SOURCE, stampField: TRIALS_STAMP_FIELD,
            freshnessDays: DEFAULT_TRIALS_FRESHNESS_DAYS, chunkSizeOverride: 50,
            compounds: corpus(5), nowMs: NOW, nowIso: NOW_ISO, queryChunk,
        });
        expect(res.degraded).toBe(true);
        expect(res.queriedCount).toBe(0);
        // No stamp written -> the whole chunk stays eligible.
        expect(fakeStampStore.has(SOURCE)).toBe(false);
        // Cursor NOT advanced (the real silent-skip vector) -> the failed chunk is re-attempted.
        expect(fakeCursorStore.has(SOURCE)).toBe(false);
    });

    it('PR-1: queryChunk REJECTS (throws, e.g. OpenAlex/S2 outage) -> DEGRADE, NOT a throw out of runCoverageStage', async () => {
        const queryChunk = vi.fn(async () => { throw new Error('OpenAlex HTTP 429 (Too Many Requests)'); });
        const res = await runCoverageStage({
            label: 'PAPER-LINKER', source: SOURCE, stampField: TRIALS_STAMP_FIELD,
            freshnessDays: DEFAULT_TRIALS_FRESHNESS_DAYS, chunkSizeOverride: 50,
            compounds: corpus(5), nowMs: NOW, nowIso: NOW_ISO, queryChunk,
        });
        expect(res.degraded).toBe(true);
        expect(res.queriedCount).toBe(0);
        // The thrown-outage path must ALSO leave both stores untouched.
        expect(fakeStampStore.has(SOURCE)).toBe(false);
        expect(fakeCursorStore.has(SOURCE)).toBe(false);
    });

    it('PR-1: a genuine FROZEN CURSOR (queriedIds=[] with ZERO errors) STILL THROWS (loud, F3 exits 1)', async () => {
        const queryChunk = vi.fn(async () => ({ queriedIds: [], queryErrorCount: 0 }));
        await expect(runCoverageStage({
            label: 'TRIAL-LINKER', source: SOURCE, stampField: TRIALS_STAMP_FIELD,
            freshnessDays: DEFAULT_TRIALS_FRESHNESS_DAYS, chunkSizeOverride: 50,
            compounds: corpus(5), nowMs: NOW, nowIso: NOW_ISO, queryChunk,
        })).rejects.toThrow(/HALT/);
        // Nothing stamped / advanced on the halt.
        expect(fakeStampStore.has(SOURCE)).toBe(false);
        expect(fakeCursorStore.has(SOURCE)).toBe(false);
    });

    it('query_error_count is surfaced in the run telemetry return', async () => {
        const queryChunk = vi.fn(async (slice: any[]) => {
            // 1 failure + the rest genuine.
            const queriedIds = slice.slice(1).map(c => c.id);
            return { queriedIds, queryErrorCount: 1 };
        });
        const res = await runCoverageStage({
            label: 'PAPER-LINKER', source: SOURCE, stampField: TRIALS_STAMP_FIELD,
            freshnessDays: DEFAULT_TRIALS_FRESHNESS_DAYS, chunkSizeOverride: 50,
            compounds: corpus(3), nowMs: NOW, nowIso: NOW_ISO, queryChunk,
        });
        expect(res.queryErrorCount).toBe(1);
        expect(res.queriedCount).toBe(2);
    });
});

describe('adapter checked variants distinguish fetch-failure from genuine-empty', () => {
    const origFetch = globalThis.fetch;
    beforeEach(() => { globalThis.fetch = origFetch; });

    it('CT.gov searchByInterventionChecked: HTTP 200 + 0 studies -> ok:true (genuine empty)', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ studies: [] }) })) as any;
        const r = await searchByInterventionChecked('nonexistent-drug', 100);
        expect(r.ok).toBe(true);
        expect(r.terminal).toBe(false);
        expect(r.studies).toEqual([]);
    });

    it('CT.gov searchByInterventionChecked: HTTP 503 -> ok:false TRANSIENT (terminal:false, NOT stamped, stays eligible)', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
        const r = await searchByInterventionChecked('aspirin', 100);
        expect(r.ok).toBe(false);
        expect(r.terminal).toBe(false); // 5xx is transient -> the PR-1 degrade path, stays eligible
        expect(r.studies).toEqual([]);
    });

    it('CT.gov searchByInterventionChecked: HTTP 429 -> ok:false TRANSIENT (terminal:false -- rate limit, retry)', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as any;
        const r = await searchByInterventionChecked('aspirin', 100);
        expect(r.ok).toBe(false);
        expect(r.terminal).toBe(false); // 429 is transient, NOT terminal
    });

    it('CT.gov searchByInterventionChecked: HTTP 400 -> ok:false TERMINAL (terminal:true -- malformed/unsearchable, NOT a transient error)', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })) as any;
        const r = await searchByInterventionChecked('(1S)-4,17-dimethyl-[bracketed-iupac]', 100);
        expect(r.ok).toBe(false);
        expect(r.terminal).toBe(true); // 400 = malformed query -> terminal, must NOT inflate queryErrorCount
        expect(r.studies).toEqual([]);
    });

    it('CT.gov searchByInterventionChecked: network/timeout reject -> ok:false TRANSIENT (terminal:false, no status)', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('AbortError: timeout'); }) as any;
        const r = await searchByInterventionChecked('aspirin', 100);
        expect(r.ok).toBe(false);
        expect(r.terminal).toBe(false); // a network reject carries no HTTP status -> transient
        expect(r.studies).toEqual([]);
    });

    it('OpenAlex searchChecked: at least ONE sub-query 200 -> ok:true (genuine, even if 0 merged results)', async () => {
        let n = 0;
        globalThis.fetch = vi.fn(async () => {
            n++;
            // first sub-query 200 (empty), second errors -> still a genuine query overall.
            if (n === 1) return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
            return { ok: false, status: 500, json: async () => ({}) } as any;
        }) as any;
        const r = await searchChecked('some-drug', 10);
        expect(r.ok).toBe(true);
        expect(r.results).toEqual([]);
    });

    it('OpenAlex searchChecked: ALL sub-queries error -> ok:false (total fetch failure)', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as any;
        const r = await searchChecked('some-drug', 10);
        expect(r.ok).toBe(false);
        expect(r.results).toEqual([]);
    });
});
