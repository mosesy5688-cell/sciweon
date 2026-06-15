/**
 * RK-16C OFFLINE SPIKE — cursor + read-budget LIST traversal (OFFLINE).
 *
 * Drives a bounded, multi-request LIST walk over a posting list (flat page refs
 * OR a two-level directory) using the REUSED A1 substrate: the unsigned cursor
 * (encode/decode/revalidate) + the LIST ReadBudget profile. It NEVER scans-to-
 * fill: each request charges control (directory) + posting (page) sub-requests
 * against the LIST budget and STOPS the instant a charge is refused, returning a
 * next_cursor. Canonical reads are charged 0 (LIST canonical_max == 0).
 *
 * Imports the worker TS directly (Node 24 strips types; cursor.ts + read-budget
 * .ts have no extensionless local imports). No HMAC, base64url, offline.
 */

import { encode, decode, revalidateCursor } from '../../../../src/worker/lib/rk16/cursor.ts';
import { newReadBudget } from '../../../../src/worker/lib/rk16/read-budget.ts';

export const FAMILY = 'bioactivities';

/**
 * Flatten a posting list to an ordered PostingPageRef[]. If two-level, reading
 * the directory costs ONE control charge; if flat the inline refs cost nothing
 * extra (they live in the manifest the LIST already loaded).
 * @returns {{ pages: object[], directoryControlCharges: number }}
 */
function resolvePages(postingList, directoryPages) {
    if (Array.isArray(postingList)) {
        return { pages: postingList, directoryControlCharges: 0 };
    }
    // two-level: directoryPages is the PostingPageRef[] inside the directory.
    return { pages: directoryPages, directoryControlCharges: 1 };
}

/**
 * One bounded LIST request. Walks pages from `start` (page_ordinal,in_page_offset)
 * charging the LIST budget; returns the rows collected + next_cursor (or null) +
 * the read tally. recordSource(pageRef) returns the page's projection rows.
 */
export function listRequest(opts) {
    const { postingList, directoryPages, recordSource, snapshotIdentity,
        indexKey, partition, filterFingerprint, start, pageCap = Infinity } = opts;
    const budget = newReadBudget('LIST');
    const { pages, directoryControlCharges } = resolvePages(postingList, directoryPages);

    for (let i = 0; i < directoryControlCharges; i++) {
        if (!budget.chargeControl()) break; // directory read (control)
    }

    const result = [];
    let ordinal = start.page_ordinal;
    let offset = start.in_page_offset;
    let stoppedForBudget = false;

    while (ordinal < pages.length) {
        if (!budget.chargePosting()) { stoppedForBudget = true; break; }
        const rows = recordSource(pages[ordinal]);
        const heap = Buffer.byteLength(JSON.stringify(rows), 'utf-8');
        if (!budget.addParsedHeap(heap)) { stoppedForBudget = true; break; }
        for (let j = offset; j < rows.length; j++) {
            if (result.length >= pageCap) {
                return finish(result, budget, opts, ordinal, j, true);
            }
            result.push(rows[j]);
        }
        offset = 0;
        ordinal += 1;
    }

    if (stoppedForBudget && ordinal < pages.length) {
        return finish(result, budget, opts, ordinal, offset, true);
    }
    // fully drained
    return finish(result, budget, opts, ordinal, 0, false);
}

function finish(result, budget, opts, ordinal, offset, more) {
    const next_cursor = more
        ? encode({
            cursor_version: 1,
            snapshot_identity: opts.snapshotIdentity,
            family: FAMILY,
            index_key: opts.indexKey,
            partition: opts.partition,
            page_ordinal: ordinal,
            in_page_offset: offset,
            filter_fingerprint: opts.filterFingerprint,
        })
        : null;
    return {
        rows: result,
        next_cursor,
        reads: {
            control: budget.controlUsed,
            posting: budget.postingUsed,
            canonical: budget.canonicalUsed,
            total: budget.totalUsed,
        },
        parsed_heap: budget.parsedHeapUsed,
        exhausted: budget.exhausted,
    };
}

/**
 * Full traversal across MULTIPLE bounded requests (NO single-request scan-to-
 * fill). Returns the total rows, request count, and the WORST-case per-request
 * read tally (the read-budget proof for a heavy hitter).
 */
export function fullWalk(baseOpts, ctxFor) {
    let cursor = null;
    let start = { page_ordinal: 0, in_page_offset: 0 };
    const all = [];
    let requests = 0;
    let worst = { control: 0, posting: 0, canonical: 0, total: 0 };

    for (;;) {
        const res = listRequest({ ...baseOpts, start });
        requests += 1;
        all.push(...res.rows);
        worst = maxReads(worst, res.reads);
        if (!res.next_cursor) break;
        const payload = revalidateCursor(decode(res.next_cursor), ctxFor(res));
        cursor = res.next_cursor;
        start = { page_ordinal: payload.page_ordinal, in_page_offset: payload.in_page_offset };
        if (requests > 100000) throw new Error('[cursor-walk] runaway');
    }
    return { rows: all, requests, worst_reads: worst, last_cursor: cursor };
}

function maxReads(a, b) {
    return {
        control: Math.max(a.control, b.control),
        posting: Math.max(a.posting, b.posting),
        canonical: Math.max(a.canonical, b.canonical),
        total: Math.max(a.total, b.total),
    };
}
