/**
 * Harvester Pass-2 engine — the no-loss batch bookkeeping for pubchem-harvester.
 *
 * Extracted from pubchem-harvester.js (PR-2) so the batch path is independently
 * testable (network-free, deps-injected) and the harvester stays under the CES
 * 250-line monolith cap. Holds:
 *   - makeState()      : the harvest state object (shared by Pass-1 + Pass-2).
 *   - processEntity()  : post-fetch bookkeeping for one (cid, entity) pair —
 *                        SHARED by the single-CID path (Pass-1) and batch (Pass-2),
 *                        so batch output is byte-identical to single-CID.
 *   - runBatchPass2()  : the 100-CID-chunk sweep via getCompoundsBatch (~20x).
 *   - assertNoLoss()   : the hard attempted == valid+excluded+noRecord+failed
 *                        invariant ([[feedback_cross_cycle_silent_data_loss]]).
 */

import { getCompoundsBatch } from './pubchem-batch.js';
import { COMPOUND_SCHEMA } from '../../../src/lib/schemas/compound.js';
import { gate } from './validation-gate.js';

export const PROP_CHUNK_SIZE = 100; // CIDs per PubChem batch-property POST (Pass-2)
export const BATCH_DELAY_MS = 250;  // 4 req/sec — PubChem rate limit is 5/sec

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function makeState() {
    return {
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
        excludedOutOfScope: [],  // PR-HARVEST-SCOPE-TIER: scope-tier exclusions (macromolecules etc.)
    };
}

/**
 * Post-fetch bookkeeping for a single (cid, entity) pair — SHARED by the
 * single-CID path (processOneCid / Pass-1) and the batch path (Pass-2). entity
 * is null when the CID was reached but has no usable record (deprecated /
 * superseded / missing InChIKey). normalize is the sole entity constructor on
 * both paths, so batch output is byte-identical to single-CID (bar the 2 ISO
 * timestamps). Callers own attempted++/fetched++ (kept out of here so a
 * fetch-failed CID — counted attempted, never fetched — is not double-counted).
 */
export function processEntity(cid, entity, state) {
    if (!entity) {
        // V0.5.6 (2026-05-19): track the CID instead of silently dropping it.
        // Adapter returns null for deprecated/superseded CIDs or records that
        // failed InChIKey normalization — operator needs a paper trail per
        // [[feedback_cross_cycle_silent_data_loss]] Pattern A.
        state.noPropertyRecord.push(cid);
        console.warn(`[PUBCHEM] CID ${cid}: no property record (deprecated/superseded or missing InChIKey) — tracked in manifest.no_property_record_cids`);
        return;
    }

    // gate() in REJECT mode:
    //   - throws on primary violations (chain halts; bad primary data
    //     must NEVER pollute production R2).
    //   - returns {passed: false, excluded: true, exclusion_reason} on
    //     scope-tier violations (intentional out-of-domain exclusions
    //     like macromolecules > 10000 Da). Caller skips + telemetry-buckets.
    //     Added 2026-05-27 PR-HARVEST-SCOPE-TIER after F1 run 26512200020
    //     halted the entire 5000-CID range on a single CID:111615 macromolecule
    //     (18657 Da) -- batch of 1600 successful records lost to halt-before-commit.
    //   - returns {passed: true} otherwise (derived-only warnings allowed).
    const result = gate(entity, COMPOUND_SCHEMA, `CID:${cid}`);
    if (result.excluded) {
        state.excludedOutOfScope.push({
            cid,
            reason: result.exclusion_reason,
            exclusions: result.exclusions?.map(e => ({ path: e.path, error: e.error })) ?? [],
        });
        return;
    }
    state.entities.push(entity);
    state.valid++;
    if (result.warnings) {
        state.warned++;
        state.violationsLog.push({ cid, warnings: result.warnings });
    }
}

/**
 * Batch Pass-2 — sweep [startCid, startCid+limit) in PROP_CHUNK_SIZE (=100)
 * chunks via getCompoundsBatch instead of the single-CID getCompound loop
 * (~20x: ~40-60min -> ~1-3min). The no-loss core lives in getCompoundsBatch;
 * here every requested CID is routed to exactly ONE bucket:
 *   - entitiesByCid hit  -> fetched++, processEntity(entity)
 *   - noRecord hit       -> fetched++, processEntity(null) (reached, no record)
 *   - getCompoundsBatch threw (transient 5xx/network) -> all N -> failedFetches
 *   - unaccounted        -> IMPOSSIBLE-GUARD throw (a silent drop is loud)
 * `getBatch` is injectable for network-free tests (defaults to the real one).
 * `sleepFn` lets tests skip the inter-chunk delay.
 */
export async function runBatchPass2(state, startCid, limit, {
    getBatch = getCompoundsBatch,
    chunkSize = PROP_CHUNK_SIZE,
    delayMs = BATCH_DELAY_MS,
    sleepFn = sleep,
} = {}) {
    for (let base = startCid; base < startCid + limit; base += chunkSize) {
        const end = Math.min(base + chunkSize, startCid + limit);
        const chunk = [];
        for (let cid = base; cid < end; cid++) chunk.push(cid);

        state.attempted += chunk.length; // count BEFORE fetch — every requested CID is attempted
        let res;
        try {
            res = await getBatch(chunk.map(Number));
        } catch (err) {
            // Transient 5xx / network / timeout: all N legitimately never
            // fetched -> blanket-requeue (parity with single-CID getCompound throw).
            const msg = err && err.message ? err.message : String(err);
            for (const cid of chunk) state.failedFetches.push({ cid, error: msg });
            console.warn(`[PUBCHEM] batch ${base}-${end - 1} transient failure (${chunk.length} CIDs -> retry queue): ${msg}`);
            await sleepFn(delayMs);
            continue;
        }

        const noRec = new Set(res.noRecord);
        for (const cid of chunk) {                 // ascending -> deterministic output
            const k = String(cid);
            if (res.entitiesByCid.has(k)) {
                state.fetched++;
                processEntity(cid, res.entitiesByCid.get(k), state);
            } else if (noRec.has(k)) {
                state.fetched++;                   // reached, no usable record
                processEntity(cid, null, state);
            } else {
                // A requested CID that is NEITHER an entity NOR a noRecord is a
                // bug in getCompoundsBatch's accounting — fail LOUD, never drop.
                throw new Error(`[HARVESTER] INVARIANT: CID ${cid} unaccounted by getCompoundsBatch`);
            }
        }
        console.log(`[HARVESTER] Progress: ${state.attempted} attempted | ${state.fetched} fetched | ${state.valid} valid | ${state.warned} warned | ${state.excludedOutOfScope.length} excluded_scope | ${state.failedFetches.length} fetch_failed | ${state.noPropertyRecord.length} no_record`);
        await sleepFn(delayMs);
    }
}

/**
 * NO-LOSS INVARIANT — every attempted CID lands in exactly one terminal bucket:
 * an emitted entity (valid), an out-of-scope exclusion, a no-property-record,
 * or a transient fetch failure. A mismatch means a CID was silently dropped
 * somewhere — fail LOUD ([[feedback_cross_cycle_silent_data_loss]] is iron).
 * Covers BOTH passes: Pass-1 (processOneCid) and Pass-2 (runBatchPass2) feed
 * the same buckets and both increment attempted, so the global tally holds.
 */
export function assertNoLoss(state) {
    const accounted = state.valid
        + state.excludedOutOfScope.length
        + state.noPropertyRecord.length
        + state.failedFetches.length;
    if (state.attempted !== accounted) {
        throw new Error(
            `[HARVESTER] NO-LOSS INVARIANT VIOLATED: attempted=${state.attempted} != ` +
            `valid=${state.valid} + excluded=${state.excludedOutOfScope.length} + ` +
            `noRecord=${state.noPropertyRecord.length} + failed=${state.failedFetches.length} (=${accounted})`
        );
    }
}
