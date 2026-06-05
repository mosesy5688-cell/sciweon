/**
 * Aggregated Bundle Merger — V0.5.2.1
 *
 * Merges the current cycle's aggregated bundle with the previously
 * published aggregated bundle so the API surface sees ALL cumulative
 * data, not just the latest cycle.
 *
 * Why this exists: pre-V0.5.2.1 Sciweon snapshots were per-cycle
 * (cycle-N upload completely replaced the API-visible state). R2 still
 * held cycle-1..N-1 baselines in `processed/baseline/<run_id>/` but
 * the read-side `processed/aggregated/latest.json` pointer always
 * referenced the just-written aggregated bundle, dropping all prior
 * compounds from API view. This is a write-amplification-without-
 * read-aggregation anti-pattern (see cross-cycle silent data loss
 * lesson).
 *
 * Merge policy (per V0.5.2.1 scope, locked 2026-05-17):
 *   1. Replace-by-id (newer cycle wins). A compound / trial / paper /
 *      bioactivity / neg-evidence record with the same id in both
 *      current and previous: current wins. This handles the retry-queue
 *      case where a CID failed in cycle N-1 then succeeded in cycle N.
 *   2. Append-then-dedupe for entity types lacking stable id (link files):
 *      dedupe by composite key (compound_id + target_id).
 *   3. No cross-cycle re-linking. Old compounds don't get new
 *      trial/paper enrichment in this PR. Trial-linker and paper-linker
 *      already ran on current cycle compounds only; cross-cycle linking
 *      is V0.6+ scope.
 *
 * Memory budget (V0.5.2.1 ceiling):
 *   At 25K cumulative compounds × ~5KB per entity, the merge holds
 *   ~125 MB in memory — well within GHA runner's 7GB limit.
 *   At ~200K cumulative this approach starts hitting GC pressure and
 *   must be replaced with stream/chunk merge. TODO marker in code
 *   tracks that ceiling.
 */

import fs from 'fs/promises';
import path from 'path';

const LINKED_DIR = './output/linked';

// Files to merge from previous aggregated bundle. Mirrors Stage 3's
// AGGREGATED_FILES list.
//
// PR-CORE-DRUG-LABEL-LEAK followup 2026-05-28: drug-labels.jsonl added (it was
// published in AGGREGATED_FILES but NOT in MERGE_FILES -> the stage-3-merger
// only iterates MERGE_FILES, so prev drug-labels.jsonl never merged = effectively
// REPLACE-per-cycle, F2 unhydrated cur silently overwrote prev hydrated). Adding
// it here makes it cumulative + activates the deepMergeDrugLabel strategy below.
const MERGE_FILES = [
    'compounds-enriched.jsonl',
    'bioactivities.jsonl',
    'trials.jsonl',
    'trial-links.jsonl',
    'papers.jsonl',
    'paper-links.jsonl',
    'negative-evidence-raw.jsonl',
    'neg-evidence.jsonl',
    'drug-labels.jsonl',
];

// Per-file key extractor. Entity files use `id`; link files use a
// composite (compound + target) key since they may lack stable id.
function defaultKey(rec) {
    return typeof rec?.id === 'string' && rec.id.length > 0 ? rec.id : null;
}

function linkKey(rec) {
    const compound = rec?.compound_id || rec?.subject?.compound_id || '';
    // M3: trial/ctis-trial-linker write `nct_id` (NO trial_id); reading trial_id
    // first -> null key -> trial-links bypassed dedup -> unbounded dup accumulation.
    const trial = rec?.nct_id || rec?.trial_id || rec?.subject?.trial_id || '';
    const paper = rec?.paper_id || rec?.subject?.paper_id || '';
    const other = trial || paper || '';
    if (!compound || !other) return null;
    return `${compound}::${other}`;
}

const KEY_FN_PER_FILE = {
    'compounds-enriched.jsonl': defaultKey,
    'bioactivities.jsonl': defaultKey,
    'trials.jsonl': defaultKey,
    'papers.jsonl': defaultKey,
    'negative-evidence-raw.jsonl': defaultKey,
    'neg-evidence.jsonl': defaultKey,
    'trial-links.jsonl': linkKey,
    'paper-links.jsonl': linkKey,
};

// PR-CORE-MERGE-LEAK (cycle 23): per-file deep-merge strategy. See
// aggregated-deep-merge.js for the deepMergeCompound contract + rationale.
// PR-CORE-DRUG-LABEL-LEAK (2026-05-28): adds drug-labels axis to prevent
// F2 emit of unhydrated cur from reverse-erasing PR-RXN-1b-pre-promote
// hydrated ndcs[]/rxcui[] in prev.
import { deepMergeCompound, deepMergeDrugLabel, bootstrapPrevRecords } from './aggregated-deep-merge.js';

const MERGE_STRATEGY_PER_FILE = Object.freeze({
    'compounds-enriched.jsonl': deepMergeCompound,
    'drug-labels.jsonl': deepMergeDrugLabel,
});

function parseJsonl(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); }
        catch { /* malformed line, skip */ }
    }
    return out;
}

function serializeJsonl(records) {
    return records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

/**
 * Merge previous + current records for one file.
 * Replace-by-key: when same key in both, current wins.
 * No-key records (where keyFn returns null): pass through from both.
 */
export function mergeRecords(currentRecords, previousRecords, keyFn, strategyFn) {
    const byKey = new Map();
    const noKeyRecords = [];
    let fromPrevious = 0;
    let fromCurrent = 0;
    let replaced = 0;
    const deepCounters = strategyFn ? {
        total: 0, preservedExternalIdFields: 0, unionedSources: 0,
        preservedStructuralFields: 0, preservedF3Fields: 0, sample: [],
    } : null;

    for (const rec of previousRecords) {
        const k = keyFn(rec);
        if (k === null) { noKeyRecords.push(rec); continue; }
        byKey.set(k, rec);
        fromPrevious++;
    }

    for (const rec of currentRecords) {
        const k = keyFn(rec);
        if (k === null) { noKeyRecords.push(rec); continue; }
        if (byKey.has(k)) {
            replaced++;
            fromPrevious--;
            if (strategyFn) {
                byKey.set(k, strategyFn(byKey.get(k), rec, deepCounters));
            } else {
                byKey.set(k, rec);
            }
        } else {
            byKey.set(k, rec);
        }
        fromCurrent++;
    }

    // M3 LOUD no-key guard: no-key records bypass dedup -> future key drift silently accumulates dups (the nct_id bug class). Surface the count.
    if (noKeyRecords.length > 0) {
        console.warn(`[AGGREGATED-MERGER] WARN: ${noKeyRecords.length} no-key records bypassed dedup (pass-through) -- if keyed, the key extractor may have drifted (dup accumulation risk).`);
    }
    return {
        merged: [...byKey.values(), ...noKeyRecords],
        stats: {
            from_current: fromCurrent,
            from_previous_kept: fromPrevious,
            replaced_by_current: replaced,
            no_key_passthrough: noKeyRecords.length,
            total: byKey.size + noKeyRecords.length,
            ...(deepCounters ? {
                merged_deep_total: deepCounters.total,
                merged_deep_preserved_external_id_fields: deepCounters.preservedExternalIdFields,
                merged_deep_unioned_sources_count: deepCounters.unionedSources,
                merged_deep_preserved_structural_fields: deepCounters.preservedStructuralFields,
                merged_deep_preserved_f3_fields: deepCounters.preservedF3Fields,
                merged_deep_sample: deepCounters.sample,
            } : {}),
        },
    };
}

async function readLocalFile(fname) {
    const p = path.join(LINKED_DIR, fname);
    try { return await fs.readFile(p, 'utf-8'); }
    catch (err) {
        if (err.code === 'ENOENT') return '';
        throw err;
    }
}

async function writeLocalFile(fname, text) {
    const p = path.join(LINKED_DIR, fname);
    await fs.mkdir(LINKED_DIR, { recursive: true });
    await fs.writeFile(p, text, 'utf-8');
}

/**
 * Merge the current cycle's local aggregated files (already in LINKED_DIR
 * after trial-linker / paper-linker / neg-evidence-builder ran) with the
 * supplied previous aggregated buffers (downloaded from R2 by caller).
 *
 * previousBuffers: { [fname]: Buffer | string } — content of each file
 *   from the previously published aggregated bundle. Missing entries
 *   (file not in previous bundle) are treated as empty.
 *
 * Side effect: overwrites files in LINKED_DIR with merged content.
 *
 * Returns: { perFile: { [fname]: stats }, totalMergedRecords }
 */
export async function mergeLocalAggregatedWithPrevious(previousBuffers) {
    const perFile = {};
    let totalMergedRecords = 0;

    for (const fname of MERGE_FILES) {
        const keyFn = KEY_FN_PER_FILE[fname] || defaultKey;
        const currentText = await readLocalFile(fname);
        const currentRecords = parseJsonl(currentText);

        const prevRaw = previousBuffers[fname];
        const prevText = prevRaw instanceof Buffer
            ? prevRaw.toString('utf-8')
            : (typeof prevRaw === 'string' ? prevRaw : '');
        const previousRecords = parseJsonl(prevText);

        // PR-FDA-SRS-3c: prev-load boundary mass-backfill for compounds. Runs on
        // the FULL prev array (incl prev-only records that never enter
        // deepMergeCompound; the misplaced SRS-3 call there silent-skipped 28,097).
        let bootstrapStats = null;
        if (fname === 'compounds-enriched.jsonl') {
            bootstrapStats = bootstrapPrevRecords(previousRecords);
        }

        // TODO V0.6+: at ~200K cumulative compounds this in-memory merge
        // hits GHA runner GC pressure; replace with streaming chunk merge
        // when total cumulative compound count crosses 100K.
        const strategyFn = MERGE_STRATEGY_PER_FILE[fname] || null;
        const { merged, stats } = mergeRecords(currentRecords, previousRecords, keyFn, strategyFn);

        if (bootstrapStats) {
            stats.prev_bootstrap_count = bootstrapStats.count;
            stats.prev_bootstrap_sample = bootstrapStats.sample;
        }

        await writeLocalFile(fname, serializeJsonl(merged));
        perFile[fname] = stats;
        totalMergedRecords += stats.total;
    }

    return { perFile, totalMergedRecords };
}

export { MERGE_FILES, KEY_FN_PER_FILE, MERGE_STRATEGY_PER_FILE };
