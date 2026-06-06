/**
 * Stage-3 linker orchestration + exit-decision (PR-1 F3 outage-decouple).
 *
 * EXTRACTED from stage-3-aggregate.js so the orchestration + the
 * failureCount/exit-decision is (a) unit-testable without spawning the real F3
 * main() and (b) keeps stage-3-aggregate.js under the Art 5.1 250-line cap.
 *
 * ===== THE INCIDENT THIS FIXES =====
 * F3 was cancelled when the paper-linker mass-failed (OpenAlex HTTP 429): the
 * linker `Promise.all` + the cross-link `runSequential` were UN-WRAPPED, so any
 * thrown linker/cross-link branch propagated out and ABORTED the whole stage
 * BEFORE the (unrelated) FAERS openFDA backfill -- the FDA data payoff -- and
 * before the F4 publish. A 3rd-party paper/trial API outage must NEVER abort F3.
 *
 * ===== THE CONTRACT (target end-state) =====
 *   - A linker that DEGRADED (3rd-party outage, exits 0 -> resolves) is a SUCCESS
 *     here: it does NOT count toward failureCount -> F3 exits 0 -> F4 publishes the
 *     FAERS payoff. The runner already left the chunk eligible + un-stamped + the
 *     prior entity file intact (no-silent-loss, see lib/linker-coverage-runner.js).
 *   - A linker that GENUINELY THREW (frozen cursor / real bug / cross-link
 *     assertLoaded) is CAUGHT here (so execution continues to the FAERS backfill),
 *     logged LOUD, recorded as a failed summary, and COUNTS toward failureCount ->
 *     F3 exits 1 -> F4 does NOT publish (correct: a real bug shouldn't publish).
 *   - NOTHING is swallowed silently: every caught failure surfaces in the summary
 *     and drives the exit code.
 */

/**
 * Run a sequence of sub-script tasks, stopping the sequence on the FIRST failure
 * but NOT re-throwing out of the group. A failed task is recorded as a loud
 * { ok:false } summary; subsequent tasks in the SAME group are skipped (their data
 * would be built on the failed task's missing output). The caller derives the exit
 * code from the returned summaries' `ok` flags -- a failure is counted, never lost.
 *
 * (V0.5.x previously re-threw IMMEDIATELY here, which aborted the entire stage
 * before the FAERS backfill. PR-1 makes it non-fatal-to-the-stage while STILL
 * recording the failure so it drives the exit code -- the abort is the bug, the
 * failure-accounting is preserved.)
 *
 * @param {string} label
 * @param {{name: string, fn: () => Promise<void>}[]} tasks
 * @returns {Promise<{task: string, ok: boolean, error: string|null}[]>}
 */
export async function runSequential(label, tasks) {
    console.log(`\n[STAGE-3] === ${label} (sequential) ===`);
    const summaries = [];
    for (const t of tasks) {
        try {
            await t.fn();
            summaries.push({ task: t.name, ok: true, error: null });
        } catch (err) {
            // LOUD: a sub-script failure stops THIS group (downstream tasks depend on
            // its output) but is recorded + counted, not swallowed and not stage-fatal.
            console.error(`[STAGE-3] ${label}/${t.name} failed (group halted, recorded as failure -- F3 continues to the FAERS backfill): ${err.message}`);
            summaries.push({ task: t.name, ok: false, error: err.message });
            break; // do not run later tasks on the failed task's missing/partial output.
        }
    }
    return summaries;
}

/**
 * Synthesize a one-entry failed summary for a group whose orchestration itself
 * rejected (defense-in-depth: runSequential no longer throws, but a Promise.all
 * branch or a cold-start Promise could still reject). LOUD; counts as a failure.
 */
function failedGroup(name, err) {
    console.error(`[STAGE-3] linker group '${name}' threw (caught, recorded as failure -- F3 continues to the FAERS backfill): ${err.message}`);
    return [{ task: name, ok: false, error: err.message }];
}

/**
 * Run all linker groups (parallel, disjoint output files) + the cross-link group,
 * each wrapped non-fatal so a thrown branch is CAUGHT (execution continues to the
 * FAERS backfill) but recorded as a failed summary. Returns the flat summary list
 * + the derived failureCount (the F3 exit driver).
 *
 * @param {(name: string) => Promise<void>} runScript  spawns a sub-script (exit 0 = resolve).
 * @param {{snomedColdStart: boolean, loincColdStart: boolean}} flags
 * @returns {Promise<{summaries: object[], failureCount: number, groups: object}>}
 */
export async function runLinkerStage(runScript, { snomedColdStart, loincColdStart }) {
    const wrap = (name, p) => p.catch(err => failedGroup(name, err));

    const [
        trialResults, paperResults, targetResults, diseaseResults,
        meshResults, snomedResults, loincResults,
    ] = await Promise.all([
        wrap('Trials', runSequential('Trials', [
            { name: 'trial-linker', fn: () => runScript('trial-linker.js') },
            { name: 'ctis-trial-linker', fn: () => runScript('ctis-trial-linker.js') },
            { name: 'trial-results-enricher', fn: () => runScript('trial-results-enricher.js') },
        ])),
        wrap('Papers', runSequential('Papers', [
            { name: 'paper-linker', fn: () => runScript('paper-linker.js') },
        ])),
        wrap('Targets', runSequential('Targets', [
            { name: 'target-linker', fn: () => runScript('target-linker.js') },
            { name: 'uniprot-target-enrich', fn: () => runScript('uniprot-target-enrich.js') },
        ])),
        wrap('Diseases', runSequential('Diseases', [
            { name: 'disease-linker', fn: () => runScript('disease-linker.js') },
        ])),
        wrap('MeSH', runSequential('MeSH', [{ name: 'mesh-concept-linker', fn: () => runScript('mesh-concept-linker.js') }])),
        snomedColdStart
            ? Promise.resolve([{ task: 'snomed-concept-linker', ok: true, error: null, skipped: 'snomed-cold-start' }])
            : wrap('SNOMED', runSequential('SNOMED', [{ name: 'snomed-concept-linker', fn: () => runScript('snomed-concept-linker.js') }])),
        loincColdStart
            ? Promise.resolve([{ task: 'loinc-concept-linker', ok: true, error: null, skipped: 'loinc-cold-start' }])
            : wrap('LOINC', runSequential('LOINC', [{ name: 'loinc-concept-linker', fn: () => runScript('loinc-concept-linker.js') }])),
    ]);

    const crossLinkResults = await wrap('Cross-link + Negative Evidence', runSequential('Cross-link + Negative Evidence', [
        { name: 'bidirectional-linker', fn: () => runScript('bidirectional-linker.js') },
        { name: 'neg-evidence-builder', fn: () => runScript('neg-evidence-builder.js') },
    ]));

    const groups = {
        trialResults, paperResults, targetResults, diseaseResults,
        meshResults, snomedResults, loincResults, crossLinkResults,
    };
    const failureCount = computeFailureCount(groups);
    return { summaries: Object.values(groups).flat(), failureCount, groups };
}

/**
 * The F3 exit driver. A DEGRADED linker exits 0 -> resolves -> ok:true here, so it
 * is correctly EXCLUDED from failureCount (F3 exits 0 -> F4 publishes the FAERS
 * payoff). A GENUINE throw is ok:false -> counted (F3 exits 1 -> no publish).
 * (Mirrors the original stage-3 math: trials + papers + diseases + cross-link;
 * targets/mesh/snomed/loinc were not counted there and are not counted here.)
 */
export function computeFailureCount(groups) {
    return groups.trialResults.filter(r => !r.ok).length
        + groups.paperResults.filter(r => !r.ok).length
        + groups.diseaseResults.filter(r => !r.ok).length
        + groups.crossLinkResults.filter(r => !r.ok).length;
}
