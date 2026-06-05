/**
 * getCompoundsBatch — the no-data-loss core of the F1 batch harvest (PR-2).
 *
 * Replaces pubchem-harvester Pass-2's single-CID getCompound loop (~250ms/CID
 * = ~40-60min for the 5000-CID range) with 100-CID POST batches (~1-3min, ~20x)
 * WITHOUT losing a single good compound. Built on PR-1's now-working batch
 * helpers (batchFetchProperties + batchFetchSynonyms, both POST + in-run retry).
 *
 * GUARANTEE (zero silent data loss — [[feedback_cross_cycle_silent_data_loss]]):
 *   - Every requested CID that PubChem returns a usable record for -> an entity.
 *   - Every requested CID that is REACHED but lacks a usable record (omitted by
 *     the 200, or normalize->null on a missing InChIKey) -> noRecord (a paper
 *     trail the caller buckets in no_property_record; never silently dropped).
 *   - A poison/dead CID that 4xx/404s the WHOLE batch is ISOLATED by BISECT so
 *     its 99 good neighbors are preserved (the panel's data-loss regression).
 *   - A genuine transient 5xx/network/timeout re-throws so the caller blanket-
 *     requeues all N (they were never fetched) — matching the single-CID path.
 */

import {
    batchFetchProperties as realBatchFetchProperties,
    batchFetchSynonyms as realBatchFetchSynonyms,
    normalize as realNormalize,
} from '../../ingestion/adapters/pubchem-adapter.js';

/**
 * 4xx-vs-5xx detection (read from lib/fetch-with-retry.js):
 *   - A NON-retryable 4xx is thrown IMMEDIATELY (first attempt, no backoff)
 *     with message `HTTP <status>: <url>` — NO `(attempt N/M)` suffix.
 *   - A retryable 5xx/429 is re-thrown only AFTER all attempts exhaust; its
 *     LAST error carries `... (attempt N/M)`.
 *   - Network errors / AbortSignal timeout throw a non-`HTTP `-prefixed message.
 * So a clean 4xx (and only a clean 4xx) matches `^HTTP 4\d\d(:| )`. A 5xx
 * (`HTTP 503: ... (attempt 3/3)`) does NOT match `4\d\d`; network/timeout don't
 * start with `HTTP 4`. -> match = BISECT, no match = re-throw (requeue).
 *
 * Fragility note: this is a string contract with fetch-with-retry.js. If that
 * helper ever attaches a numeric status to the error, prefer `err.status`.
 * Until then the regex is anchored + status-classed (4\d\d) so a 5xx message
 * that merely CONTAINS a 4xx-looking URL fragment cannot false-positive.
 */
function isCleanHttp4xx(err) {
    const msg = err?.message ?? String(err);
    return /^HTTP 4\d\d(:| )/.test(msg);
}

export async function getCompoundsBatch(cids, deps = {}) {
    const {
        batchFetchProperties: fetchProps = realBatchFetchProperties,
        batchFetchSynonyms:   fetchSyns  = realBatchFetchSynonyms,
        normalize:            norm       = realNormalize,
    } = deps;

    // ── HAPPY PATH ──────────────────────────────────────────────────────────
    // Properties are load-bearing and ride the rejection path (4xx -> bisect,
    // 5xx -> re-throw). Synonyms are non-fatal: a genuine 5xx exhaustion in the
    // synonyms leg must NOT zero out properties — catch it INSIDE this leg and
    // fall back to an empty Map (every CID -> [] synonyms, parity with the
    // single-CID fetchSynonyms catch->[]), but LOG so the [] is VISIBLE, not a
    // masked silent zero. Kept OUT of the properties' Promise.all rejection path
    // so a synonyms blip never aborts the (load-bearing) properties leg.
    let props;
    let synMap;
    try {
        [props, synMap] = await Promise.all([
            fetchProps(cids),
            fetchSyns(cids).catch(e => {
                console.warn(`[PUBCHEM] synonyms batch failed (non-fatal, [] synonyms): ${e?.message ?? e}`);
                return new Map();
            }),
        ]);
    } catch (err) {
        // Clean non-retryable 4xx -> BISECT to isolate the offender(s).
        if (isCleanHttp4xx(err)) {
            if (cids.length === 1) {
                // A single CID that genuinely 4xx/404s: a real dead/poison CID.
                // ISOLATED here, never re-batched -> noRecord (paper trail).
                return { entitiesByCid: new Map(), noRecord: [String(cids[0])] };
            }
            // Synonyms are re-fetched per recursion, so a poison CID can never
            // zero out a healthy neighbor's synonyms.
            const mid = Math.floor(cids.length / 2);
            const a = await getCompoundsBatch(cids.slice(0, mid), deps);
            const b = await getCompoundsBatch(cids.slice(mid), deps);
            return {
                entitiesByCid: new Map([...a.entitiesByCid, ...b.entitiesByCid]),
                noRecord: [...a.noRecord, ...b.noRecord],
            };
        }
        // Transient 5xx / network / timeout: all N legitimately never fetched.
        // Re-throw so the caller blanket-requeues (do NOT bisect a 5xx).
        throw err;
    }

    // ── 200-WITH-OMISSIONS BUCKETING ────────────────────────────────────────
    // FIRST-WINS on duplicate CIDs (mirrors fetchCompound's Properties[0]).
    const propsByCid = new Map();
    for (const p of props) {
        const k = String(p.CID);
        if (!propsByCid.has(k)) propsByCid.set(k, p);
    }

    const entitiesByCid = new Map();
    const noRecord = [];
    // Iterate the REQUESTED cids in the caller-given order (harvester passes
    // ascending) -> deterministic output. requested-minus-returned = the dead-
    // CID omission paper trail.
    for (const cid of cids) {
        const k = String(cid);
        const raw = propsByCid.get(k);
        if (raw === undefined) {
            noRecord.push(k);                       // omitted by the 200 = no record
            continue;
        }
        const entity = norm(raw, synMap.get(k) ?? []);
        if (entity === null) {
            noRecord.push(k);                       // normalize null (missing InChIKey)
            continue;
        }
        entitiesByCid.set(k, entity);
    }
    return { entitiesByCid, noRecord };
}
