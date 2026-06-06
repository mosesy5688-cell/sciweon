/**
 * Trial Linker V0.2 (PR-B coverage-ceiling) -- links Compound -> Clinical Trials.
 *
 * Strategy: for each ELIGIBLE compound (cursored-advance + skip-if-fresh, see
 * lib/linker-coverage-runner.js) query ClinicalTrials.gov by intervention name,
 * normalize matched trials, link via intervention name, track Negative Evidence
 * (TERMINATED/WITHDRAWN with whyStopped).
 *
 * ===== PR-B: O(50) COVERAGE-CEILING FIX (stage-audit finding B2) =====
 * BEFORE: a fixed `--limit=50` + slice(0, 50); the F3 orchestrator passes NO
 * argv, so every daily run re-queried only the OLDEST 50 of the ~7,312-trial
 * corpus -- the rest were NEVER reached, and the linker exited 0, so this
 * permanent coverage CEILING was SILENT (violating the preserve-all ruling).
 * AFTER: a CURSORED-ADVANCE drain (reusing the enrichment-cursor substrate) walks
 * ALL compounds across runs; a per-compound freshness STAMP (queried-at) lets the
 * cursor SKIP compounds queried within the window (default 30d) and advance to
 * un-queried / stale ones. Bounded pMap concurrency + the shared CT.gov token
 * bucket pace the API. A coverage-invariant hard-fail (eligible>0 && queried==0
 * -> THROW) refuses to exit 0 on a frozen cursor. CADENCE, never a cap.
 *
 * Stamp storage (deviation flagged in the PR body): the queried-at stamp lives in
 * R2 state/linker-query-stamps/trial_linker.jsonl, NOT compound.linkage.* . WHY:
 * trial-linker + paper-linker run in PARALLEL and both read compounds-enriched
 * .jsonl; writing a `linkage` object back from both would race + deepMergeCompound
 * replaces the whole `linkage` wholesale, clobbering one stamp. Also the linkers
 * run BEFORE the cumulative merge, so a bundle stamp is invisible until next run.
 * R2 `state/` (the cursor's channel) is collision-free + readable at run start.
 *
 * Usage:
 *   node scripts/factory/trial-linker.js [--input=...] [--clinical-only]
 *     [--freshness-days=N] [--chunk-size=N]
 * Output: output/linked/{trials,trial-links,negative-evidence-raw}.jsonl
 *         R2 state/linker-query-stamps/trial_linker.jsonl (freshness state)
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { searchByInterventionChecked, normalize as normalizeTrial } from '../ingestion/adapters/clinicaltrials-adapter.js';
import { TRIAL_SCHEMA } from '../../src/lib/schemas/trial.js';
import { gate } from './lib/validation-gate.js';
import { classifyBatch } from './lib/failure-classifier.js';
import { pickTrialSearchName } from './lib/trial-search-name.js';
import { loadJsonlStrict, assertLoaded } from './lib/jsonl-io.js';
import { pMap } from './lib/p-map.js';
import { TRIAL_RATE_LIMITER } from './lib/rate-limiter.js';
import { runCoverageStage } from './lib/linker-coverage-runner.js';
import { DEFAULT_TRIALS_FRESHNESS_DAYS, TRIALS_STAMP_FIELD } from './lib/linker-coverage.js';

const LABEL = 'TRIAL-LINKER';
const SOURCE = 'trial_linker';
const INPUT = process.argv.find(a => a.startsWith('--input='))?.split('=')[1]
    || './output/linked/compounds-enriched.jsonl';
const CLINICAL_ONLY = process.argv.includes('--clinical-only');
const OUTPUT_DIR = './output/linked';
const FRESHNESS_DAYS = Number(process.argv.find(a => a.startsWith('--freshness-days='))?.split('=')[1])
    || Number(process.env.TRIAL_FRESHNESS_DAYS) || DEFAULT_TRIALS_FRESHNESS_DAYS;
const CHUNK_SIZE_OVERRIDE = Number(process.argv.find(a => a.startsWith('--chunk-size='))?.split('=')[1]) || null;
// Bounded concurrency within a chunk; the shared token bucket (~0.83 req/s) is
// the true rate bound. Small (CT.gov is the tight service).
const CTGOV_CONCURRENCY = Number(process.env.TRIAL_CONCURRENCY) || 3;

async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

// Query CT.gov for one chunk, write the entity outputs, return queried ids.
async function queryChunk(slice, _nowIso) {
    const allTrials = new Map(); // NCT ID -> Trial entity (dedup this run)
    const trialLinks = [];
    const negativeEvidenceRaw = [];
    const sourceCounts = {};
    const queriedIds = [];
    const noSearchableNameSample = []; // a few CIDs for loud telemetry

    let queryErrorCount = 0;        // LOUD: CT.gov fetch failures (429/5xx/timeout/outage -- TRANSIENT)
    let noSearchableNameCount = 0;  // LOUD: compounds with NO CT.gov-searchable name (terminal, NOT an error)

    const perCompound = await pMap(slice, CTGOV_CONCURRENCY, async (compound) => {
        const { name: searchName, source: searchSource } = pickTrialSearchName(compound);
        // NO CT.gov-searchable name (no rxnorm_name, no clean synonym, only IUPAC/CID):
        // do NOT send a doomed query (IUPAC -> HTTP 400; `CID:<n>` -> zero-hit waste).
        // Resolve in-place WITHOUT a network call / a rate-limiter token.
        if (searchSource === 'no_searchable_name') {
            return { compound, searchName, searchSource, noSearchableName: true };
        }
        await TRIAL_RATE_LIMITER.acquire(); // bound the true CT.gov request rate
        const { ok, terminal, studies } = await searchByInterventionChecked(searchName, 100);
        return { compound, searchName, searchSource, ok, terminal, trials: studies };
    });

    for (const { compound, searchName, searchSource, ok, terminal, noSearchableName, trials } of perCompound) {
        sourceCounts[searchSource] = (sourceCounts[searchSource] ?? 0) + 1;
        // NO CT.gov-SEARCHABLE NAME -- a recorded queryable negative, NOT a fetch
        // failure ([[evidence_not_verdict]]). It IS processed: push to queriedIds so
        // the cursor ADVANCES + it is stamped (re-evaluated when its stamp goes stale
        // in the freshness window, picking up a name that appears later). It is NOT
        // counted in queryErrorCount, so it can never inflate the transient count or
        // (as an all-no_searchable_name chunk) trip the frozen-cursor THROW.
        // A 400 that still reached CT.gov (terminal:true -- belt-and-suspenders) is
        // the SAME class: unsearchable, deterministic, NOT transient -> treat as such.
        if (noSearchableName || terminal) {
            noSearchableNameCount++;
            if (noSearchableNameSample.length < 5) noSearchableNameSample.push(compound.id);
            queriedIds.push(compound.id); // PROCESSED -> advances the cursor, gets stamped
            continue;
        }
        // FETCH-FAILURE (not a genuine result): do NOT stamp -- the compound stays
        // eligible + is retried next wrap. Stamping it would skip it for the whole
        // freshness window ([[cross_cycle_silent_data_loss]]).
        if (!ok) {
            queryErrorCount++;
            console.warn(`[${LABEL}] query FAILED for ${compound.id} ("${searchName}") -- NOT stamping, stays eligible`);
            continue;
        }
        // Genuine query (HTTP 200): zero trials still counts -- the stamp advances coverage.
        queriedIds.push(compound.id);
        for (const raw of trials) {
            const trial = normalizeTrial(raw, compound.id);
            if (!trial) continue;
            if (!gate(trial, TRIAL_SCHEMA, `trial:${trial.nct_id}`).passed) continue;
            if (!allTrials.has(trial.nct_id)) {
                allTrials.set(trial.nct_id, trial);
                if (trial.is_negative_outcome) {
                    negativeEvidenceRaw.push({
                        nct_id: trial.nct_id, compound_id: compound.id, compound_name: searchName,
                        status: trial.status, status_reason: trial.status_reason,
                        phase: trial.phase, conditions: trial.conditions,
                    });
                }
            }
            trialLinks.push({ compound_id: compound.id, nct_id: trial.nct_id, intervention_name: searchName });
        }
    }

    // Determinism: stable sort outputs.
    const trialsOut = [...allTrials.values()].sort((a, b) => a.id.localeCompare(b.id));
    trialLinks.sort((a, b) => (a.compound_id + a.nct_id).localeCompare(b.compound_id + b.nct_id));
    negativeEvidenceRaw.sort((a, b) => (a.nct_id + a.compound_id).localeCompare(b.nct_id + b.compound_id));

    // LOUD telemetry (no-silent-loss): the no-searchable-name compounds are RECORDED,
    // never silently skipped. They ARE counted in queriedIds (cursor advances + they
    // are stamped), distinct from a transient error -- re-evaluated each freshness
    // window so a name that appears later is picked up.
    if (noSearchableNameCount > 0) {
        console.warn(`[${LABEL}] no_searchable_name=${noSearchableNameCount} (no rxnorm_name/clean synonym -> only IUPAC/CID, NOT CT.gov-searchable; skipped the query, stamped as processed -- NOT a fetch failure). sample=${JSON.stringify(noSearchableNameSample)}`);
    }

    // ITEM 4 (PR-1) NO-TRUNCATION + the no_searchable_name fix: writing [] over
    // trials.jsonl truncates the PRIOR run's file -> downstream assertLoaded
    // (snomed/loinc/bidirectional linkers) HARD-FAILS on the empty file. SKIP the
    // write whenever there is NOTHING to persist this chunk -- either a TOTAL outage
    // (queriedIds=[]) OR a chunk that produced zero trials (e.g. an all-
    // no_searchable_name slice, or a slice whose genuine queries all returned empty).
    // The cursor still advances (queriedIds is returned), the prior trials.jsonl is
    // left intact (the cumulative merge reads it), so NO data is lost and NO downstream
    // HALT is triggered.
    if (queriedIds.length === 0 || trialsOut.length === 0) {
        const why = queriedIds.length === 0 ? 'TOTAL outage (0 compounds genuinely queried)' : 'no trials produced this chunk';
        console.warn(`[${LABEL}] ${why} -- SKIPPING entity-file writes to preserve prior trials.jsonl (no truncation). queried=${queriedIds.length} no_searchable_name=${noSearchableNameCount} query_error_count=${queryErrorCount}`);
        return { queriedIds, queryErrorCount };
    }

    await writeJsonl(path.join(OUTPUT_DIR, 'trials.jsonl'), trialsOut);
    await writeJsonl(path.join(OUTPUT_DIR, 'trial-links.jsonl'), trialLinks);
    await writeJsonl(path.join(OUTPUT_DIR, 'negative-evidence-raw.jsonl'), negativeEvidenceRaw);

    const classificationStats = classifyBatch(negativeEvidenceRaw);
    console.log(`[${LABEL}] this-run trials=${trialsOut.length} links=${trialLinks.length} negatives=${negativeEvidenceRaw.length}`);
    console.log(`[${LABEL}] failure classification: ${JSON.stringify(classificationStats)}`);
    console.log(`[${LABEL}] search-name source distribution: ${JSON.stringify(sourceCounts)}`);
    // LOUD outage visibility (M8): a CT.gov fetch failure is COUNTED, never silent.
    if (queryErrorCount > 0) {
        console.warn(`[${LABEL}] query_error_count=${queryErrorCount} (CT.gov fetch failures this run -- those compounds stay eligible for retry)`);
    }
    return { queriedIds, queryErrorCount };
}

async function main() {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    console.log(`[${LABEL}] V0.2 PR-B cursored-advance | input: ${INPUT} | freshness=${FRESHNESS_DAYS}d | concurrency=${CTGOV_CONCURRENCY}`);
    if (CLINICAL_ONLY) console.log(`[${LABEL}] Filter: only compounds with max_phase >= 1`);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    let compounds = await loadJsonlStrict(INPUT);
    assertLoaded(compounds, LABEL, INPUT); // never proceed on a truncated input
    if (CLINICAL_ONLY) {
        compounds = compounds.filter(c => c.drug_status?.max_phase != null && c.drug_status.max_phase >= 1);
    }

    await runCoverageStage({
        label: LABEL, source: SOURCE, stampField: TRIALS_STAMP_FIELD,
        freshnessDays: FRESHNESS_DAYS, chunkSizeOverride: CHUNK_SIZE_OVERRIDE,
        compounds, nowMs, nowIso, queryChunk,
    });
    console.log(`[${LABEL}] SUCCESS`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error(`[${LABEL}] Fatal:`, err); process.exit(1); });
}

export { main, queryChunk };
