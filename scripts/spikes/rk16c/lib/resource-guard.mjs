/**
 * RK-16C FULL-CORPUS SPIKE (M4) — PROCESS-LEVEL resource envelope.
 *
 * Two real guards, both fail-closed and BUILD-inert (no network, no large
 * allocation here):
 *
 *  1. MEMORY MONITOR — samples process.memoryUsage() (heapUsed, heapTotal, rss,
 *     external, arrayBuffers) at an interval; on a hard-ceiling breach
 *     (max heapUsed OR max rss) it STOPS and records a BOUNDED failure (it does
 *     NOT crash the harness silently). The Node old-space hard ceiling
 *     (--max-old-space-size=<N>) is documented in the report + run command; this
 *     monitor is the in-process backstop that records WHICH ceiling broke.
 *
 *  2. DISK ENVELOPE — a temp-disk FORMULA covering every byte the run can land,
 *     plus a free-space PREFLIGHT that checks available disk BEFORE any network
 *     read and FAILS BEFORE NETWORK if insufficient. The full run STREAMS the
 *     gzip payload and NEVER lands a decompressed file (proved in code + test);
 *     the formula reflects that (streaming path = no decompressed materialization).
 */

import fs from 'fs';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Default hard ceilings (fail-closed). Tuned for a ~60 MiB compressed corpus. */
export const DEFAULT_MAX_HEAP_USED_BYTES = 512 * MiB;
export const DEFAULT_MAX_RSS_BYTES = 1 * GiB;
/** Documented Node old-space hard ceiling to run WITH (--max-old-space-size). */
export const REQUIRED_NODE_OLD_SPACE_MIB = 512;

/** A full process memory sample (NOT just V8 heap). */
export function memorySample() {
    const m = process.memoryUsage();
    return {
        heapUsed: m.heapUsed,
        heapTotal: m.heapTotal,
        rss: m.rss,
        external: m.external,
        arrayBuffers: m.arrayBuffers,
    };
}

function maxSample(a, b) {
    return {
        heapUsed: Math.max(a.heapUsed, b.heapUsed),
        heapTotal: Math.max(a.heapTotal, b.heapTotal),
        rss: Math.max(a.rss, b.rss),
        external: Math.max(a.external, b.external),
        arrayBuffers: Math.max(a.arrayBuffers, b.arrayBuffers),
    };
}

/**
 * Start a memory monitor. Samples at `intervalMs`; on breach of `maxHeapUsed`
 * or `maxRss` it records a bounded failure and stops sampling (it does not
 * throw from the timer — the caller checks `.breached` / `.failure`). Returns a
 * handle: { sample(), stop(), peak, breached, failure, samples }.
 */
export function startMemoryMonitor(opts = {}) {
    const maxHeapUsed = opts.maxHeapUsedBytes != null ? opts.maxHeapUsedBytes : DEFAULT_MAX_HEAP_USED_BYTES;
    const maxRss = opts.maxRssBytes != null ? opts.maxRssBytes : DEFAULT_MAX_RSS_BYTES;
    const intervalMs = opts.intervalMs != null ? opts.intervalMs : 250;

    const handle = {
        maxHeapUsedBytes: maxHeapUsed,
        maxRssBytes: maxRss,
        intervalMs,
        peak: memorySample(),
        samples: 0,
        breached: false,
        failure: null,
        _timer: null,
    };

    const tick = () => {
        const s = memorySample();
        handle.samples += 1;
        handle.peak = maxSample(handle.peak, s);
        if (s.heapUsed > maxHeapUsed || s.rss > maxRss) {
            handle.breached = true;
            handle.failure = {
                kind: s.heapUsed > maxHeapUsed ? 'over_heap_used_ceiling' : 'over_rss_ceiling',
                heapUsed: s.heapUsed,
                rss: s.rss,
                maxHeapUsedBytes: maxHeapUsed,
                maxRssBytes: maxRss,
                note: 'process-level memory ceiling breached — bounded failure recorded; monitor stopped (harness not crashed)',
            };
            stop();
        }
    };

    function stop() {
        if (handle._timer) { clearInterval(handle._timer); handle._timer = null; }
    }

    handle.sample = tick;
    handle.stop = stop;
    tick(); // immediate first sample
    handle._timer = setInterval(tick, intervalMs);
    if (handle._timer && typeof handle._timer.unref === 'function') handle._timer.unref();
    return handle;
}

/**
 * Temp-disk FORMULA (bytes). Streaming path: NO decompressed file is landed, so
 * the decompressed term is 0 and is documented as "streamed, never materialized".
 * Covers: partial-download slack + verified-final-compressed + temp index/output
 * + 12-cell result artifacts + failure residue + cleanup reserve.
 */
export function tempDiskFormula(opts = {}) {
    const compressedBytes = opts.compressedBytes != null ? opts.compressedBytes : 60 * MiB;
    const cellCount = opts.cellCount != null ? opts.cellCount : 12;
    const perCellArtifactBytes = opts.perCellArtifactBytes != null ? opts.perCellArtifactBytes : 8 * MiB;

    const partial_download_slack = compressedBytes; // a stalled retry may hold a second partial copy
    const verified_final_compressed = compressedBytes;
    const decompressed_materialization = 0; // STREAMED — never lands a decompressed file
    const temp_index_output = 64 * MiB;
    const result_artifacts_12cell = cellCount * perCellArtifactBytes;
    const failure_residue = 32 * MiB;
    const subtotal = partial_download_slack + verified_final_compressed
        + decompressed_materialization + temp_index_output
        + result_artifacts_12cell + failure_residue;
    const cleanup_reserve = Math.ceil(subtotal * 0.25); // 25% headroom for cleanup churn
    const required_free_bytes = subtotal + cleanup_reserve;

    return {
        decompressed_path: 'STREAMED — gzip is processed as a stream; NO decompressed file is ever written to disk',
        terms: {
            partial_download_slack,
            verified_final_compressed,
            decompressed_materialization,
            temp_index_output,
            result_artifacts_12cell,
            failure_residue,
            cleanup_reserve,
        },
        subtotal,
        required_free_bytes,
    };
}

/** Available free bytes on the filesystem holding `dir` (Node fs.statfsSync). */
export function freeBytesFor(dir) {
    try {
        const st = fs.statfsSync(dir);
        return st.bavail * st.bsize;
    } catch {
        return null; // unknown — preflight treats unknown as a fail-closed below
    }
}

/**
 * Free-space PREFLIGHT — call BEFORE any network read. Returns { ok, ... }.
 * If available free space is unknown or below the formula's required_free_bytes,
 * ok=false (the runner must FAIL BEFORE NETWORK). Pure check, no allocation.
 */
export function diskPreflight(dir, opts = {}) {
    const formula = tempDiskFormula(opts);
    const available = freeBytesFor(dir);
    const ok = available != null && available >= formula.required_free_bytes;
    return {
        ok,
        dir,
        available_bytes: available,
        required_free_bytes: formula.required_free_bytes,
        formula,
        reason: ok
            ? 'sufficient free temp disk'
            : available == null
                ? 'free space UNKNOWN — fail-closed (cannot prove sufficient temp disk before network)'
                : `insufficient free temp disk: available=${available} < required=${formula.required_free_bytes}`,
    };
}

/** Throwing wrapper: FAIL BEFORE NETWORK when temp disk is insufficient. */
export function requireDiskPreflight(dir, opts = {}) {
    const r = diskPreflight(dir, opts);
    if (!r.ok) {
        throw new Error(`[rk16c-resource] disk preflight FAILED BEFORE NETWORK: ${r.reason}`);
    }
    return r;
}
