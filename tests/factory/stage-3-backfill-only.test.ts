// @ts-nocheck
/**
 * WO_F3 backfill_only branch (lib/stage-3-backfill-only.js) tests.
 *
 * Covers the 12-gate-aligned acceptance for the F3 backfill_only isolation:
 *   Gate 1 (default unchanged): proven structurally -- the false branch calls the
 *     identical runLinkerStage; these tests pin the TRUE-branch helpers so a
 *     regression in them can never silently alter the default path.
 *   Gate 2 (skip runLinkerStage): synthesizeBackfillOnlyLinkerStage = a synthetic
 *     clean stage (failureCount 0, empty groups) installed INSTEAD of running the linkers.
 *   Gate 4 (FAERS still reached): the branch sets linkerStage without return/exit, so
 *     the unconditional FAERS backfill below it in main() still runs (the synthetic
 *     stage proves the branch produces a consumable stage object, not a halt).
 *   Gate 5/6 (rehydrate FAIL-LOUD, no partial publish): rehydratePriorLinkerFiles
 *     throws on an absent pointer OR any missing/empty expected linker-only file --
 *     it NEVER continues with a partial set.
 *   Gate 7 (F4 never missing a linker file): LINKER_ONLY_FILES is derived as
 *     AGGREGATED_FILES \ MERGE_FILES \ downstream-rebuilt and pinned, so the rehydrate
 *     set is exactly the files F4 would otherwise be missing.
 *
 * No real R2 / fs: the rehydrate is dependency-injected with fakes; the helpers are pure.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    LINKER_ONLY_FILES, DOWNSTREAM_REBUILT_FILES, requiredLinkerOnlyFiles,
    synthesizeBackfillOnlyLinkerStage, rehydratePriorLinkerFiles,
} from '../../scripts/factory/lib/stage-3-backfill-only.js';
import { AGGREGATED_FILES } from '../../scripts/factory/lib/aggregated-files.js';
import { MERGE_FILES } from '../../scripts/factory/lib/aggregated-merger.js';

describe('WO_F3 LINKER_ONLY_FILES derivation (AGGREGATED \\ MERGE \\ downstream-rebuilt)', () => {
    it('derives EXACTLY the 5 stamped-in-place linker-produced files', () => {
        // Pinned so a future drift in AGGREGATED_FILES / MERGE_FILES is caught in CI.
        expect([...LINKER_ONLY_FILES].sort()).toEqual([
            'diseases.jsonl',
            'loinc-concepts.jsonl',
            'mesh-concepts.jsonl',
            'snomed-concepts.jsonl',
            'targets.jsonl',
        ]);
    });

    it('every LINKER_ONLY file is in AGGREGATED_FILES, none in MERGE_FILES, none downstream-rebuilt', () => {
        for (const f of LINKER_ONLY_FILES) {
            expect(AGGREGATED_FILES).toContain(f);             // it is an F4-published file
            expect(MERGE_FILES).not.toContain(f);              // the cumulative merge does NOT rehydrate it
            expect(DOWNSTREAM_REBUILT_FILES).not.toContain(f); // nothing later in the stage rebuilds it
        }
    });

    it('the *-public projections + sal-assertions + indices are EXCLUDED (they are rebuilt downstream)', () => {
        for (const f of [
            'mesh-concepts-public.jsonl', 'snomed-concepts-public.jsonl', 'loinc-concepts-public.jsonl',
            'sal-assertions.jsonl', 'sciweon-search-index.json', 'target-index.json',
            'compounds-search.jsonl', 'xref-index.json',
        ]) {
            expect(LINKER_ONLY_FILES).not.toContain(f);
        }
    });

    it('requiredLinkerOnlyFiles excludes a cold-start vocabulary file (mirrors the default-path skip)', () => {
        const cold = requiredLinkerOnlyFiles({ snomedColdStart: true, loincColdStart: true });
        expect(cold).not.toContain('snomed-concepts.jsonl');
        expect(cold).not.toContain('loinc-concepts.jsonl');
        // targets/diseases/mesh have no cold-start guard -> always required.
        expect(cold).toEqual(['targets.jsonl', 'diseases.jsonl', 'mesh-concepts.jsonl']);
        // warm = all 5
        expect(requiredLinkerOnlyFiles({}).length).toBe(5);
    });
});

describe('WO_F3 synthesizeBackfillOnlyLinkerStage (Gate 2: synthetic clean stage)', () => {
    it('failureCount === 0 and every group is an empty array', () => {
        const s = synthesizeBackfillOnlyLinkerStage();
        expect(s.failureCount).toBe(0);
        expect(s.summaries).toEqual([]);
        for (const k of [
            'trialResults', 'paperResults', 'crossLinkResults', 'targetResults',
            'diseaseResults', 'meshResults', 'snomedResults', 'loincResults',
        ]) {
            expect(s.groups[k]).toEqual([]);
        }
    });
    it('the groups shape matches what stage-3-aggregate.js destructures (summary lines stay safe)', () => {
        const { groups } = synthesizeBackfillOnlyLinkerStage();
        // stage-3-aggregate.js: const { trialResults, paperResults, crossLinkResults } = linkerStage.groups
        const { trialResults, paperResults, crossLinkResults } = groups;
        expect(trialResults.filter(r => r.ok).length).toBe(0);
        expect(paperResults.filter(r => r.ok).length).toBe(0);
        expect(crossLinkResults.filter(r => r.ok).length).toBe(0);
    });
});

describe('WO_F3 rehydratePriorLinkerFiles (Gate 5/6/7: fail-loud, no partial set)', () => {
    const makeBuf = (s) => Buffer.from(s, 'utf-8');
    function fakeDeps(overrides = {}) {
        const written = {};
        return {
            written,
            deps: {
                readStagePointer: vi.fn(async () => ({ run_id: 'PRIOR-RUN-1' })),
                downloadStageByRunId: vi.fn(async (_stage, _runId, files) => {
                    const out = {};
                    for (const f of files) out[f] = makeBuf(`{"id":"x","file":"${f}"}\n`);
                    return out;
                }),
                writeFile: vi.fn(async (p, data) => { written[p] = data; }),
                mkdir: vi.fn(async () => {}),
                pathJoin: (...p) => p.join('/'),
                logger: { log: vi.fn(), error: vi.fn() },
                snomedColdStart: false,
                loincColdStart: false,
                ...overrides,
            },
        };
    }

    it('warm path: downloads + writes all 5 required files, returns them', async () => {
        const { deps, written } = fakeDeps();
        const res = await rehydratePriorLinkerFiles(deps);
        expect(res.runId).toBe('PRIOR-RUN-1');
        expect(res.files.sort()).toEqual([
            'diseases.jsonl', 'loinc-concepts.jsonl', 'mesh-concepts.jsonl',
            'snomed-concepts.jsonl', 'targets.jsonl',
        ]);
        expect(Object.keys(written).length).toBe(5);
        expect(deps.downloadStageByRunId).toHaveBeenCalledWith(
            'aggregated', 'PRIOR-RUN-1',
            expect.arrayContaining(['targets.jsonl', 'mesh-concepts.jsonl']),
        );
    });

    it('cold-start: snomed/loinc files are NOT required, NOT downloaded (only 3 written)', async () => {
        const { deps, written } = fakeDeps({ snomedColdStart: true, loincColdStart: true });
        const res = await rehydratePriorLinkerFiles(deps);
        expect(res.files.sort()).toEqual(['diseases.jsonl', 'mesh-concepts.jsonl', 'targets.jsonl']);
        expect(Object.keys(written).length).toBe(3);
        expect(deps.downloadStageByRunId).toHaveBeenCalledWith(
            'aggregated', 'PRIOR-RUN-1', ['targets.jsonl', 'diseases.jsonl', 'mesh-concepts.jsonl'],
        );
    });

    it('FAIL-LOUD: absent prior pointer (null) -> throws, NEVER continues (writes nothing)', async () => {
        const { deps, written } = fakeDeps({ readStagePointer: vi.fn(async () => null) });
        await expect(rehydratePriorLinkerFiles(deps)).rejects.toThrow(/no prior aggregated bundle pointer/);
        expect(Object.keys(written).length).toBe(0);
    });

    it('FAIL-LOUD: pointer without run_id -> throws', async () => {
        const { deps } = fakeDeps({ readStagePointer: vi.fn(async () => ({})) });
        await expect(rehydratePriorLinkerFiles(deps)).rejects.toThrow(/no prior aggregated bundle pointer/);
    });

    it('FAIL-LOUD: a MISSING expected linker file (empty buffer = NoSuchKey) -> throws partial-set', async () => {
        // downloadStageByRunId returns Buffer.alloc(0) for a NoSuchKey -> the integrity check must catch it.
        const { deps } = fakeDeps({
            downloadStageByRunId: vi.fn(async (_s, _r, files) => {
                const out = {};
                for (const f of files) out[f] = f === 'mesh-concepts.jsonl' ? Buffer.alloc(0) : makeBuf('{"id":"x"}\n');
                return out;
            }),
        });
        await expect(rehydratePriorLinkerFiles(deps)).rejects.toThrow(/missing or empty.*mesh-concepts\.jsonl/);
    });

    it('FAIL-LOUD: an EMPTY (zero-byte) expected linker file -> throws (no silent empty corpus publish)', async () => {
        const { deps } = fakeDeps({
            downloadStageByRunId: vi.fn(async (_s, _r, files) => {
                const out = {};
                for (const f of files) out[f] = f === 'targets.jsonl' ? makeBuf('') : makeBuf('{"id":"x"}\n');
                return out;
            }),
        });
        await expect(rehydratePriorLinkerFiles(deps)).rejects.toThrow(/missing or empty.*targets\.jsonl/);
    });
});
