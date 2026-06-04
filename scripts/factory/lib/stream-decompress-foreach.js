/**
 * Streaming zstd-decompress + per-record callback for the F3 linker family.
 *
 * GENERALIZES the proven streamDecompressFilter (lib/uniprot-stream-decompress.js,
 * PR #235) from a RETAIN-by-predicate shape to a process-EVERY-record shape. The
 * uniprot linker filters (keeps ~19k of 574k); the concept/disease/target linkers
 * instead build an index over ALL records (a Map, or a pass-through array). Both are
 * single-pass; the only difference is what onRecord does, so the streaming machinery
 * is identical and is shared here.
 *
 * WHY (same root cause as PR #235): all 5 sibling linkers used a whole-buffer
 * `spawnSync('zstd','-d','--stdout', {maxBuffer})` that materialized the ENTIRE
 * decompressed corpus in one Buffer -> ENOBUFS once it exceeds maxBuffer (the class
 * that broke the daily cascade in uniprot-target-enrich). This streams line-by-line
 * and NEVER materializes the decompressed corpus; memory is bounded by whatever
 * onRecord retains.
 *
 * ROBUSTNESS (mirrors streamDecompressFilter byte-for-byte):
 *   - async spawn('zstd','-d','--stdout','--quiet'); the compressed Buffer is written
 *     to stdin (compressed is small enough to hold);
 *   - readline over child.stdout, ONE LINE AT A TIME;
 *   - blank lines skipped; a leading `#`-prefixed header line is skipped + counted in
 *     headerSkipped (NOT in recordsSeen) IFF opts.hasHeader (default true);
 *   - resolve ONLY after BOTH readline 'close' AND child 'close', so a non-zero zstd
 *     exit (truncated/corrupt decompress) is ALWAYS observed and throws with stderr;
 *   - stdin write error (e.g. EPIPE) -> throw; spawn error -> throw;
 *   - settled-idempotent (a single `settled` latch; kill the child on failure).
 *
 * MALFORMED-LINE CONTRACT (opts.onMalformed) -- preserves each caller's existing
 * behavior exactly:
 *   - 'throw' (DEFAULT, = uniprot): a JSON.parse error HARD-FAILS the whole run with
 *     the 1-based record index (no silent drop per [[cross_cycle_silent_data_loss]]).
 *   - 'count': a JSON.parse error is NOT thrown here -- it increments the returned
 *     `malformed` count and the line is skipped; the CALLER decides what to do
 *     (the concept linkers throw iff malformed>0; disease warns; target ignores).
 *     This pushes the no-silent-drop decision to the caller WITHOUT losing the count.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

/**
 * @param {Buffer} compressed  the zstd-compressed bulk (held; small relative to corpus)
 * @param {(rec: object, index: number) => void} onRecord  per-record work (1-based index)
 * @param {{label?: string, hasHeader?: boolean, onMalformed?: 'throw'|'count'}} [opts]
 * @returns {Promise<{recordsSeen: number, headerSkipped: number, malformed: number}>}
 */
export function streamDecompressForEach(compressed, onRecord, opts = {}) {
    const label = opts.label || 'STREAM-FOREACH';
    const hasHeader = opts.hasHeader !== false; // default true (concept bulks have a # header)
    const onMalformed = opts.onMalformed === 'count' ? 'count' : 'throw';

    return new Promise((resolve, reject) => {
        const child = spawn('zstd', ['-d', '--stdout', '--quiet']);
        const stderrChunks = [];
        let recordsSeen = 0;
        let headerSkipped = 0;
        let malformed = 0;
        let settled = false;
        let lineError = null;

        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch { /* already gone */ }
            reject(err);
        };

        child.on('error', (err) => fail(new Error(`[${label}] zstd CLI spawn failed: ${err.message}`)));
        if (child.stderr) child.stderr.on('data', (c) => stderrChunks.push(c));

        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on('line', (line) => {
            if (lineError) return; // stop processing once a line failed; await child close
            const t = line.trim();
            if (!t) return;
            if (hasHeader && t.startsWith('#')) { headerSkipped++; return; }
            let rec;
            try {
                rec = JSON.parse(t);
            } catch (err) {
                if (onMalformed === 'count') { malformed++; return; }
                // 'throw': NO SILENT DROP -- HARD-FAIL with the 1-based record index.
                lineError = new Error(
                    `[${label}] JSON parse error in bulk (record #${recordsSeen + 1}): ${err.message} -- aborting (no silent drop)`);
                rl.close();
                try { child.kill(); } catch { /* already gone */ }
                return;
            }
            recordsSeen++;
            try {
                onRecord(rec, recordsSeen);
            } catch (err) {
                // An onRecord throw is a real error (not a malformed line) -- surface it loud.
                lineError = new Error(`[${label}] onRecord failed at record #${recordsSeen}: ${err.message}`);
                rl.close();
                try { child.kill(); } catch { /* already gone */ }
            }
        });
        rl.on('error', (err) => fail(new Error(`[${label}] line stream error: ${err.message}`)));

        // Resolve only after BOTH the line stream closed AND the child exited, so a
        // non-zero zstd exit (truncated/corrupt decompress) is always observed.
        let lineDone = false;
        let exitInfo = null;
        const maybeFinish = () => {
            if (settled || !lineDone || !exitInfo) return;
            if (lineError) return fail(lineError);
            const { code, signal } = exitInfo;
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
                return fail(new Error(`[${label}] zstd CLI exit ${code}${signal ? ` (signal ${signal})` : ''}: ${stderr}`));
            }
            settled = true;
            resolve({ recordsSeen, headerSkipped, malformed });
        };

        rl.on('close', () => { lineDone = true; maybeFinish(); });
        child.on('close', (code, signal) => {
            // If we deliberately killed the child after a lineError, surface lineError
            // (not the kill signal) -- exitInfo.code !== 0 path is bypassed via lineError.
            exitInfo = lineError ? { code: 0, signal: null } : { code, signal };
            maybeFinish();
        });

        // Feed the compressed buffer to zstd stdin; propagate write/EPIPE errors.
        child.stdin.on('error', (err) => fail(new Error(`[${label}] zstd stdin write failed: ${err.message}`)));
        child.stdin.write(compressed, (err) => {
            if (err) return; // 'error' handler above already rejects
            child.stdin.end();
        });
    });
}
