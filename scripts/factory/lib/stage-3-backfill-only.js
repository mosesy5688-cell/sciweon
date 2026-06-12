/**
 * Stage-3 backfill_only branch (WO_F3 -- isolate the FAERS/unichem/rxnorm
 * cumulative backfill from the S2/OpenAlex/trial linkers WITHOUT breaking the
 * F3 -> F4 publish chain).
 *
 * ===== WHY THIS EXISTS =====
 * Today stage-3-aggregate.js ALWAYS runs runLinkerStage (the ONLY caller of the
 * paper-linker = S2 DOI lookup + OpenAlex, the trial-linker, and the cross-link
 * group) BEFORE the FAERS backfill. A FAERS-recovery dispatch therefore re-runs
 * S2 (CC-BY-NC, P-7) + OpenAlex (429 / cost). `backfill_only=true` lets that run
 * SKIP the linkers and re-enrich only the existing cumulative corpus.
 *
 * ===== THE LOAD-BEARING FINDING (founder gate #5) =====
 * Skipping the linkers is NOT enough. Several files are in AGGREGATED_FILES (the
 * F3 upload SSoT) but NOT in MERGE_FILES (the cumulative-merge SSoT) and are NOT
 * rebuilt-from-fresh-inputs later in the stage -- they are stamped IN PLACE by
 * the SID stampers (which READ the existing local file). If the linkers are
 * skipped, those files are absent from ./output/linked/ -> the HARD-FAIL stampers
 * (and uploadStage's ENOENT guard) KILL the stage before F4 -> broken publish.
 *
 * The fix: rehydrate exactly those linker-produced, stamped-in-place files from
 * the prior published aggregated bundle, FAIL-LOUD on any missing/empty/absent
 * input, then let the unchanged cumulative merge / stampers / public builders /
 * projections / invariant / upload run over the synthetic-clean linker stage. The
 * downstream-rebuilt files (the *-public projections, sal-assertions, the search /
 * target indices, the compound projections) are regenerated and are therefore NOT
 * rehydrated.
 *
 * HONESTY (founder constraint): the rehydrated files are the PRIOR bundle's
 * authoritative linker output, logged explicitly as `rehydrated` -- they are
 * never disguised as freshly-linked. The normal path also replaces these files
 * per-cycle, so re-publishing the last full-run linker state is correct; the
 * FAERS-updated compounds-enriched.jsonl is the only material delta.
 */

import { AGGREGATED_FILES } from './aggregated-files.js';
import { MERGE_FILES } from './aggregated-merger.js';

/**
 * Files regenerated LATER in stage-3 (after the rehydrate point) regardless of
 * the linkers, so they MUST NOT be rehydrated (they get overwritten):
 *   - the *-concepts-public.jsonl projections  (mesh/snomed/loinc-public-builder.js)
 *   - sal-assertions.jsonl                      (stage-3-sal-sid-stamp.js builds it
 *                                                 from scratch via the SAL builders)
 *   - sciweon-search-index.json                 (search-index-builder.js)
 *   - target-index.json                         (target-index-builder.js)
 *   - compounds-search.jsonl + xref-index.json  (compound-projection-builder.js)
 * Derived as a constant (not hardcoded into LINKER_ONLY_FILES) so the derivation
 * AGGREGATED_FILES \ MERGE_FILES \ DOWNSTREAM_REBUILT is explicit + auditable.
 */
export const DOWNSTREAM_REBUILT_FILES = Object.freeze([
    'mesh-concepts-public.jsonl',
    'snomed-concepts-public.jsonl',
    'loinc-concepts-public.jsonl',
    'sal-assertions.jsonl',
    'sciweon-search-index.json',
    'target-index.json',
    'compounds-search.jsonl',
    'xref-index.json',
]);

/**
 * LINKER_ONLY_FILES = AGGREGATED_FILES \ MERGE_FILES \ DOWNSTREAM_REBUILT_FILES.
 *
 * The linker-produced files that the cumulative merge does NOT rehydrate and that
 * nothing downstream rebuilds -- they are STAMPED IN PLACE (the stamper reads the
 * existing local file). At HEAD this derives to exactly:
 *   targets.jsonl, diseases.jsonl, mesh-concepts.jsonl,
 *   snomed-concepts.jsonl, loinc-concepts.jsonl
 * (verify with the unit test that pins this derivation).
 */
export const LINKER_ONLY_FILES = Object.freeze(
    AGGREGATED_FILES.filter(f =>
        !MERGE_FILES.includes(f) && !DOWNSTREAM_REBUILT_FILES.includes(f)
    ),
);

/**
 * Files whose linker + stamper + public-builder are skipped on a vocabulary
 * cold start (PR-UMLS-3 / PR-UMLS-4). In backfill_only mode we must mirror that:
 * the full concept file is legitimately ABSENT from the prior bundle when its
 * vocabulary was cold, so it is rehydrated + fail-loud-checked ONLY when the
 * vocabulary is NOT cold. targets/diseases/mesh have no cold-start guard and are
 * therefore ALWAYS required.
 */
export const SNOMED_LINKER_ONLY_FILE = 'snomed-concepts.jsonl';
export const LOINC_LINKER_ONLY_FILE = 'loinc-concepts.jsonl';

/**
 * The set of linker-only files that MUST be rehydrated + integrity-checked given
 * the per-vocabulary cold-start flags. Cold-start vocab files are excluded (their
 * stamper/public-builder are skipped downstream, exactly as the default path).
 *
 * @param {{snomedColdStart?: boolean, loincColdStart?: boolean}} flags
 * @returns {string[]}
 */
export function requiredLinkerOnlyFiles({ snomedColdStart = false, loincColdStart = false } = {}) {
    return LINKER_ONLY_FILES.filter(f => {
        if (f === SNOMED_LINKER_ONLY_FILE && snomedColdStart) return false;
        if (f === LOINC_LINKER_ONLY_FILE && loincColdStart) return false;
        return true;
    });
}

/**
 * The SYNTHETIC clean linker stage for backfill_only mode. The linkers did NOT
 * run, so failureCount is 0 (no real failure to count) and every group is empty.
 * Shape matches what stage-3-aggregate.js + the summary lines consume
 * (trialResults / paperResults / crossLinkResults) plus the remaining group keys
 * runLinkerStage normally returns. PURE (no I/O) -> directly unit-testable.
 *
 * @returns {{summaries: object[], failureCount: number, groups: object}}
 */
export function synthesizeBackfillOnlyLinkerStage() {
    return {
        summaries: [],
        failureCount: 0,
        groups: {
            trialResults: [],
            paperResults: [],
            crossLinkResults: [],
            targetResults: [],
            diseaseResults: [],
            meshResults: [],
            snomedResults: [],
            loincResults: [],
        },
    };
}

const LINKED_DIR = './output/linked';

/**
 * Rehydrate the prior aggregated bundle's LINKER_ONLY_FILES into ./output/linked/
 * so the cumulative merge / stampers / public builders / projections / invariant /
 * upload run over a COMPLETE local set (else broken F4 publish).
 *
 * FAIL-LOUD (throws, halting the stage -> F3 non-zero -> F4 does NOT publish) if:
 *   - the prior aggregated pointer is absent (no prior bundle to rehydrate);
 *   - the pointer is malformed (no run_id);
 *   - any required LINKER_ONLY file is missing / empty / zero-byte after download.
 * It NEVER continues with a partial set (founder gate #5/#6).
 *
 * Dependency-injected (readStagePointer / downloadStageByRunId / writeFile / mkdir)
 * so it is unit-testable with fakes; production wires the real r2-stage-bridge +
 * fs/promises helpers.
 *
 * @param {{
 *   readStagePointer: (stage: string) => Promise<{run_id?: string}|null>,
 *   downloadStageByRunId: (stage: string, runId: string, files: string[]) => Promise<Record<string, Buffer>>,
 *   writeFile: (path: string, data: Buffer) => Promise<void>,
 *   mkdir: (path: string, opts: object) => Promise<unknown>,
 *   pathJoin?: (...parts: string[]) => string,
 *   logger?: { log: Function, error: Function },
 *   snomedColdStart?: boolean,
 *   loincColdStart?: boolean,
 * }} deps
 * @returns {Promise<{runId: string, files: string[], totalBytes: number}>}
 */
export async function rehydratePriorLinkerFiles(deps) {
    const {
        readStagePointer, downloadStageByRunId, writeFile, mkdir,
        pathJoin = (...p) => p.join('/'),
        logger = console,
        snomedColdStart = false, loincColdStart = false,
    } = deps;

    const required = requiredLinkerOnlyFiles({ snomedColdStart, loincColdStart });

    const pointer = await readStagePointer('aggregated');
    if (!pointer || !pointer.run_id) {
        // No prior bundle -> we have nothing to rehydrate the linker-only files
        // from. Refuse to proceed (a missing set would HARD-FAIL the stampers /
        // ENOENT the upload anyway -- fail here LOUD with a precise message).
        throw new Error(
            '[BACKFILL_ONLY] HALT: no prior aggregated bundle pointer '
            + '(processed/aggregated/latest.json absent or missing run_id) -- cannot '
            + `rehydrate the ${required.length} linker-only file(s). Refusing to publish a partial bundle.`
        );
    }
    const runId = pointer.run_id;
    logger.log(`[BACKFILL_ONLY] Rehydrating ${required.length} linker-only file(s) from prior aggregated run_id=${runId}: ${required.join(', ')}`);

    const buffers = await downloadStageByRunId('aggregated', runId, required);

    await mkdir(LINKED_DIR, { recursive: true });

    const empty = [];
    let totalBytes = 0;
    const written = [];
    for (const fname of required) {
        const buf = buffers[fname];
        // downloadStageByRunId returns Buffer.alloc(0) for a missing key (NoSuchKey)
        // AND an empty file is itself a silent-data-loss publish risk for these
        // stamped-in-place corpora -> treat missing OR empty identically as FATAL.
        if (!buf || buf.length === 0) {
            empty.push(fname);
            continue;
        }
        await writeFile(pathJoin(LINKED_DIR, fname), buf);
        totalBytes += buf.length;
        written.push(fname);
    }

    if (empty.length > 0) {
        throw new Error(
            `[BACKFILL_ONLY] HALT: ${empty.length}/${required.length} required linker-only file(s) `
            + `missing or empty in prior aggregated bundle ${runId}: ${empty.join(', ')}. `
            + 'Refusing to rehydrate a partial set (would publish an incomplete bundle).'
        );
    }

    logger.log(`[BACKFILL_ONLY] prior linker files rehydrated (${written.length} files, ${(totalBytes / 1024).toFixed(1)} KB) from processed/aggregated/${runId}/`);
    return { runId, files: written, totalBytes };
}
