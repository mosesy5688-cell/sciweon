/**
 * pMap — bounded-concurrency parallel map.
 *
 * Replaces the common `for (const x of items) { await f(x) }` pattern when
 * `f` is I/O-bound (HTTP fetch, R2 GET) and items have no inter-dependency.
 * N workers pull from a shared cursor; results are collected in
 * **task-completion order** (NOT input order). Callers that need input
 * order must sort by a stable key after the call returns.
 *
 * No external dependency by design — sciweon stays inside its $10/mo cap
 * with zero npm-surface adds for ~20 LOC of well-trodden logic.
 *
 * Error semantics: first rejection causes pMap to reject. In-flight workers
 * complete their current item (since we cannot abort an in-flight fetch
 * mid-promise without an AbortController contract) but no further items
 * are pulled from the cursor. This matches Promise.all semantics and the
 * no-silent-data-loss rule: bad data halts the chain, never silently drops.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency  positive integer, capped to items.length
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}  results in task-completion order
 */
export async function pMap(items, concurrency, fn) {
    if (!Array.isArray(items)) throw new TypeError('pMap: items must be an array');
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new TypeError(`pMap: concurrency must be a positive integer, got ${concurrency}`);
    }
    if (typeof fn !== 'function') throw new TypeError('pMap: fn must be a function');
    if (items.length === 0) return [];

    const workers = Math.min(concurrency, items.length);
    const results = [];
    let cursor = 0;
    let firstError = null;

    async function worker() {
        while (true) {
            if (firstError) return;
            const idx = cursor++;
            if (idx >= items.length) return;
            try {
                const r = await fn(items[idx], idx);
                results.push(r);
            } catch (err) {
                if (!firstError) firstError = err;
                return;
            }
        }
    }

    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (firstError) throw firstError;
    return results;
}
