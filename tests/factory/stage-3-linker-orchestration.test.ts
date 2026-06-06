// @ts-nocheck
/**
 * PR-1 (F3 outage-decouple) tests:
 *
 *   ITEM 5+6 -- stage-3 linker orchestration + exit decision (lib/stage-3-linkers.js):
 *     a thrown linker/cross-link branch is CAUGHT (execution continues to the FAERS
 *     backfill) + recorded as a failed summary that drives the exit code; a DEGRADE
 *     (sub-script exits 0) is NOT a failure -> F3 exits 0 -> F4 publishes; a genuine
 *     throw IS counted -> F3 exits 1.
 *
 *   ITEM 4 -- the no-truncation write guard (trial-linker queryChunk): on a TOTAL
 *     outage (every compound ok:false -> queriedIds=[]) the entity-file writes are
 *     SKIPPED so the prior-run trials.jsonl is left intact (no createWriteStream),
 *     instead of truncating it to [] and tripping the downstream assertLoaded.
 *
 * The real spawn/network is never touched: runScript is a fake; the trial adapter,
 * the rate limiter, and fs.createWriteStream are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
    runSequential, runLinkerStage, computeFailureCount,
} from '../../scripts/factory/lib/stage-3-linkers.js';

const FLAGS = { snomedColdStart: false, loincColdStart: false };

describe('runSequential (PR-1: non-fatal-to-stage, but failures still recorded)', () => {
    it('records each task ok:true on success', async () => {
        const out = await runSequential('G', [
            { name: 'a', fn: async () => {} },
            { name: 'b', fn: async () => {} },
        ]);
        expect(out).toEqual([
            { task: 'a', ok: true, error: null },
            { task: 'b', ok: true, error: null },
        ]);
    });

    it('a thrown task is recorded ok:false, the group HALTS (later tasks skipped), but does NOT re-throw', async () => {
        const ran: string[] = [];
        const out = await runSequential('G', [
            { name: 'a', fn: async () => { ran.push('a'); } },
            { name: 'b', fn: async () => { ran.push('b'); throw new Error('boom'); } },
            { name: 'c', fn: async () => { ran.push('c'); } },
        ]);
        expect(ran).toEqual(['a', 'b']); // c skipped (group halted on b's failure)
        expect(out).toEqual([
            { task: 'a', ok: true, error: null },
            { task: 'b', ok: false, error: 'boom' },
        ]);
    });
});

describe('runLinkerStage + computeFailureCount (PR-1 items 5+6: exit-decision)', () => {
    const okScript = vi.fn(async () => {});

    it('all linkers succeed -> failureCount 0 (F3 exits 0 -> F4 publishes)', async () => {
        const res = await runLinkerStage(okScript, FLAGS);
        expect(res.failureCount).toBe(0);
        expect(res.summaries.every(s => s.ok)).toBe(true);
    });

    it('DEGRADE (every sub-script exits 0) is NOT a failure -> failureCount 0 (F4 publishes the FAERS payoff)', async () => {
        // A degraded linker exits 0 -> runScript resolves -> ok:true. The degrade lives
        // entirely inside the sub-script (it left the chunk eligible + did not stamp).
        const degradeScript = vi.fn(async () => {/* exit 0 */});
        const res = await runLinkerStage(degradeScript, FLAGS);
        expect(res.failureCount).toBe(0);
    });

    it('a GENUINE throw in the paper-linker is CAUGHT + counted -> failureCount 1 (F3 exits 1, no publish)', async () => {
        const runScript = vi.fn(async (name: string) => {
            if (name === 'paper-linker.js') throw new Error('paper-linker.js exit 1'); // frozen cursor / real bug
        });
        const res = await runLinkerStage(runScript, FLAGS);
        expect(res.failureCount).toBe(1);
        const paper = res.groups.paperResults.find(r => r.task === 'paper-linker');
        expect(paper.ok).toBe(false);
        // CRITICAL: execution still REACHED every other group (the stage was not aborted) ->
        // in real F3 the FAERS backfill (which runs AFTER this stage) is reached.
        expect(runScript).toHaveBeenCalledWith('trial-linker.js');
        expect(runScript).toHaveBeenCalledWith('bidirectional-linker.js');
    });

    it('a cross-link assertLoaded throw is caught + counted (F3 exits 1)', async () => {
        const runScript = vi.fn(async (name: string) => {
            if (name === 'bidirectional-linker.js') throw new Error('assertLoaded HALT: 0 papers');
        });
        const res = await runLinkerStage(runScript, FLAGS);
        expect(res.failureCount).toBe(1);
        expect(res.groups.crossLinkResults[0].ok).toBe(false);
    });

    it('computeFailureCount counts trials+papers+diseases+crosslink, NOT targets/mesh/snomed/loinc', () => {
        const groups = {
            trialResults: [{ ok: true }, { ok: false }],
            paperResults: [{ ok: true }],
            targetResults: [{ ok: false }],   // NOT counted
            diseaseResults: [{ ok: false }],  // counted
            meshResults: [{ ok: false }],     // NOT counted
            snomedResults: [{ ok: false }],   // NOT counted
            loincResults: [{ ok: false }],    // NOT counted
            crossLinkResults: [{ ok: false }, { ok: false }],
        };
        expect(computeFailureCount(groups)).toBe(1 + 0 + 1 + 2); // trials1 + diseases1 + cross2 = 4
    });

    it('cold-start flags short-circuit SNOMED/LOINC to a skipped success (never a failure)', async () => {
        const res = await runLinkerStage(okScript, { snomedColdStart: true, loincColdStart: true });
        expect(res.groups.snomedResults[0].skipped).toBe('snomed-cold-start');
        expect(res.groups.loincResults[0].skipped).toBe('loinc-cold-start');
        expect(res.failureCount).toBe(0);
    });
});

// ---- ITEM 4: trial-linker no-truncation write guard ------------------------------
const createWriteStreamSpy = vi.fn();
vi.mock('fs', () => ({
    createWriteStream: (...args: any[]) => { createWriteStreamSpy(...args); throw new Error('writeJsonl should NOT be called on a total outage'); },
}));
vi.mock('fs/promises', () => ({ default: { mkdir: vi.fn(async () => {}) }, mkdir: vi.fn(async () => {}) }));
vi.mock('../../scripts/factory/lib/rate-limiter.js', () => ({
    TRIAL_RATE_LIMITER: { acquire: vi.fn(async () => {}) },
    PAPER_RATE_LIMITER: { acquire: vi.fn(async () => {}) },
}));
const searchByInterventionChecked = vi.fn();
vi.mock('../../scripts/ingestion/adapters/clinicaltrials-adapter.js', () => ({
    searchByInterventionChecked: (...a: any[]) => searchByInterventionChecked(...a),
    normalize: vi.fn(() => null),
}));

import { queryChunk as trialQueryChunk } from '../../scripts/factory/trial-linker.js';

describe('ITEM 4: trial-linker queryChunk no-truncation guard (total outage)', () => {
    beforeEach(() => { createWriteStreamSpy.mockClear(); });

    it('every compound ok:false -> queriedIds=[] -> writeJsonl is SKIPPED (prior file preserved)', async () => {
        searchByInterventionChecked.mockResolvedValue({ ok: false, studies: [] });
        const slice = [{ id: 'sciweon::compound::CID:1', synonyms: ['aspirin'] }, { id: 'sciweon::compound::CID:2', synonyms: ['ibuprofen'] }];
        const res = await trialQueryChunk(slice, '2026-06-05T00:00:00.000Z');
        expect(res.queriedIds).toEqual([]);
        expect(res.queryErrorCount).toBe(2);
        // The mock throws if createWriteStream is called; reaching here proves it was NOT.
        expect(createWriteStreamSpy).not.toHaveBeenCalled();
    });
});
