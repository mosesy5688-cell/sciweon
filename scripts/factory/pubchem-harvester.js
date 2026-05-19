/**
 * PubChem Harvester — Sciweon V0.5.1
 *
 * Two-pass run:
 *   Pass 1 (optional) — drains transient failures from the previous cycle.
 *     Caller passes RETRY_CIDS env (comma-separated CIDs); each is attempted
 *     before the main range so a CID that hit a transient HTTP 5xx /
 *     timeout last run gets re-fetched before the cursor moves past it.
 *   Pass 2 — sweeps the main [start_cid, start_cid+limit) range.
 *
 * Outputs:
 *   compounds-cid-<start>-<end>.jsonl   — entities (one per line)
 *   harvest-manifest-<start>-<end>.json — counts + failed_fetches + retry split
 *   violations-cid-<start>-<end>.json   — only when warned>0 in WARN mode
 *
 * Validation mode is read at runtime from validation-gate (REJECT default per
 * PR #14). The harvester does not flip modes; in REJECT mode gate() throws on
 * the first violation and the run halts. In WARN mode (operator override via
 * VALIDATION_MODE=warn) the run accepts violations but emits an end-of-stage
 * aggregate (A.1) and throws if the warn ratio exceeds 1% of fetched (A.2).
 *
 * A fetch error (HTTP 5xx, network, timeout) is recorded in failed_fetches.
 * A "no property record" CID (adapter returned null — deprecated/superseded
 * or missing InChIKey) is recorded in no_property_record so the operator
 * has a paper trail for every silent drop. Pattern A closure
 * ([[feedback_cross_cycle_silent_data_loss]]).
 */

import fs from 'fs/promises';
import path from 'path';
import { getCompound } from '../ingestion/adapters/pubchem-adapter.js';
import { COMPOUND_SCHEMA } from '../../src/lib/schemas/compound.js';
import { gate, getCurrentMode, MODE_WARN } from './lib/validation-gate.js';

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '1000');
const START_CID = parseInt(process.argv.find(a => a.startsWith('--start-cid='))?.split('=')[1] || '1');
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output/compounds';
const BATCH_DELAY_MS = 250; // 4 req/sec — PubChem rate limit is 5/sec
const WARN_RATIO_THRESHOLD = 0.01; // A.2: sustained drift > 1% trips THROW in WARN mode

function parseRetryList(raw) {
    if (!raw) return [];
    const seen = new Set();
    const out = [];
    for (const piece of raw.split(',')) {
        const n = parseInt(piece.trim(), 10);
        if (!Number.isInteger(n) || n < 1) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

const RETRY_CIDS = parseRetryList(process.env.RETRY_CIDS || '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function processOneCid(cid, state) {
    state.attempted++;
    let entity;
    try {
        entity = await getCompound(cid);
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn(`[PUBCHEM] CID ${cid}: ${msg}`);
        state.failedFetches.push({ cid, error: msg });
        return;
    }
    state.fetched++;
    if (!entity) {
        // V0.5.6 (2026-05-19): track the CID instead of silently dropping it.
        // Adapter returns null for deprecated/superseded CIDs or records that
        // failed InChIKey normalization — operator needs a paper trail per
        // [[feedback_cross_cycle_silent_data_loss]] Pattern A.
        state.noPropertyRecord.push(cid);
        console.warn(`[PUBCHEM] CID ${cid}: no property record (deprecated/superseded or missing InChIKey) — tracked in manifest.no_property_record_cids`);
        return;
    }

    // gate() throws in REJECT mode (default) and returns {passed: true} in
    // WARN mode. There is no {passed: false} branch — the legacy
    // `if (!result.passed) return` guard was unreachable dead code and was
    // removed in V0.5.6 to avoid keeping a silent-loss template in the
    // harvester (Pattern A defense).
    const result = gate(entity, COMPOUND_SCHEMA, `CID:${cid}`);
    state.entities.push(entity);
    state.valid++;
    if (result.warnings) {
        state.warned++;
        state.violationsLog.push({ cid, warnings: result.warnings });
    }
}

function buildHistogram(violationsLog) {
    const histogram = {};
    for (const v of violationsLog) {
        for (const w of v.warnings) {
            const cat = w.path.split('.').slice(-1)[0] || 'unknown';
            histogram[cat] = (histogram[cat] || 0) + 1;
        }
    }
    return Object.entries(histogram).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`).join(', ');
}

async function main() {
    const mode = getCurrentMode();
    const modeNote = mode === MODE_WARN
        ? `WARN (log violations, accept data; throws if warn/fetched > ${(WARN_RATIO_THRESHOLD * 100).toFixed(1)}%)`
        : 'REJECT (fail-fast on first violation)';
    console.log(`[HARVESTER] V0.5.1 — limit=${LIMIT}, start_cid=${START_CID}, retry_cids=${RETRY_CIDS.length}`);
    console.log(`[HARVESTER] Validation mode: ${modeNote}`);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const state = {
        attempted: 0,
        fetched: 0,
        valid: 0,
        warned: 0,
        entities: [],
        violationsLog: [],
        failedFetches: [],
        noPropertyRecord: [],
        retrySuccesses: [],
        retryFailures: [],
    };

    if (RETRY_CIDS.length > 0) {
        console.log(`[HARVESTER] === Pass 1: drain ${RETRY_CIDS.length} retry CIDs ===`);
        const baselineFailures = state.failedFetches.length;
        for (const cid of RETRY_CIDS) {
            await processOneCid(cid, state);
            await sleep(BATCH_DELAY_MS);
        }
        const newFailureSet = new Set(state.failedFetches.slice(baselineFailures).map(f => f.cid));
        for (const cid of RETRY_CIDS) {
            if (newFailureSet.has(cid)) state.retryFailures.push(cid);
            else state.retrySuccesses.push(cid);
        }
        console.log(`[HARVESTER] Retry pass: ${state.retrySuccesses.length} succeeded, ${state.retryFailures.length} failed again`);
    }

    console.log(`[HARVESTER] === Pass 2: range CID ${START_CID} to ${START_CID + LIMIT - 1} ===`);
    for (let cid = START_CID; cid < START_CID + LIMIT; cid++) {
        await processOneCid(cid, state);
        if (state.attempted % 50 === 0) {
            console.log(`[HARVESTER] Progress: ${state.attempted} attempted | ${state.fetched} fetched | ${state.valid} valid | ${state.warned} warned | ${state.failedFetches.length} fetch_failed | ${state.noPropertyRecord.length} no_record`);
        }
        await sleep(BATCH_DELAY_MS);
    }

    const rangeTag = `${START_CID}-${START_CID + LIMIT - 1}`;
    const outputFile = path.join(OUTPUT_DIR, `compounds-cid-${rangeTag}.jsonl`);
    await fs.writeFile(outputFile, state.entities.map(e => JSON.stringify(e)).join('\n'));

    if (state.violationsLog.length > 0) {
        const violationsFile = path.join(OUTPUT_DIR, `violations-cid-${rangeTag}.json`);
        await fs.writeFile(violationsFile, JSON.stringify(state.violationsLog, null, 2));
    }

    if (state.warned > 0) {
        console.warn(`[HARVESTER-AUDIT] ${state.warned} entities flagged across categories: ${buildHistogram(state.violationsLog)}`);
    }

    const manifest = {
        run: {
            mode,
            start_cid: START_CID,
            limit: LIMIT,
            retry_cids_in: RETRY_CIDS,
            ts: new Date().toISOString(),
        },
        stats: {
            attempted: state.attempted,
            fetched: state.fetched,
            valid: state.valid,
            warned: state.warned,
            fetch_failed_count: state.failedFetches.length,
            no_property_record_count: state.noPropertyRecord.length,
        },
        failed_fetches: state.failedFetches,
        no_property_record_cids: state.noPropertyRecord,
        retry_successes: state.retrySuccesses,
        retry_failures: state.retryFailures,
    };
    const manifestFile = path.join(OUTPUT_DIR, `harvest-manifest-${rangeTag}.json`);
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));

    console.log(`[HARVESTER] ✅ Complete: ${state.attempted} attempted | ${state.fetched} fetched | ${state.valid} valid | ${state.warned} warned | ${state.failedFetches.length} fetch_failed | ${state.noPropertyRecord.length} no_record`);
    console.log(`[HARVESTER] Output:   ${outputFile} (${state.entities.length} entities)`);
    console.log(`[HARVESTER] Manifest: ${manifestFile}`);

    if (mode === MODE_WARN && state.fetched > 0) {
        const ratio = state.warned / state.fetched;
        if (ratio > WARN_RATIO_THRESHOLD) {
            throw new Error(
                `[HARVESTER] WARN ratio ${(ratio * 100).toFixed(2)}% exceeds threshold ` +
                `${(WARN_RATIO_THRESHOLD * 100).toFixed(1)}% — sustained schema drift treated as ` +
                `REJECT trigger. Manifest written; investigate before next harvest.`
            );
        }
    }
}

main().catch(err => { console.error('[HARVESTER] Fatal:', err.message); process.exit(1); });
