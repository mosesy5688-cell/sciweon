/**
 * Streaming zstd-decompress + line-filter for the UniProt bulk (PR fix:
 * was a spawnSync whole-buffer decompress with maxBuffer=1GB, which ENOBUFS'd
 * on the ~1.19GB decompressed sprot.jsonl and aborted the daily F3 cascade).
 *
 * TRUE STREAMING: the compressed buffer (~64MB, fine to hold) is written to an
 * async `spawn('zstd', ['-d','--stdout','--quiet'])` child's stdin; the child's
 * STDOUT is piped through readline so we parse ONE LINE AT A TIME and RETAIN only
 * target-hitting records. The whole ~1.19GB decompressed corpus is NEVER
 * materialized -- memory is bounded to the ~19k retained records.
 *
 * SEMANTICS PRESERVED byte-for-byte vs the old whole-string streamFilterBulk:
 *   - the leading `#`-prefixed license_metadata header line is skipped and counted
 *     in headerSkipped (NOT in records_seen);
 *   - blank lines are skipped;
 *   - every non-header/non-blank line increments records_seen, is JSON.parse'd
 *     (a parse error HARD-FAILS with the record index -- NO silent drop per
 *     [[cross_cycle_silent_data_loss]]), and is retained iff hitsTarget(rec) else
 *     unmatchedUniprot++.
 * LOUDNESS: a non-zero zstd exit throws with stderr; a stdin write error (e.g.
 * EPIPE) is propagated as a throw; the line stream is awaited to 'close'.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

/**
 * @param {Buffer} compressed  the zstd-compressed bulk (held; ~64MB is fine)
 * @param {(rec: object) => boolean} hitsTarget  retain predicate (true => keep)
 * @param {string} label  log/throw label prefix
 * @returns {Promise<{retained: object[], recordsSeen: number, unmatchedUniprot: number, headerSkipped: number}>}
 */
export function streamDecompressFilter(compressed, hitsTarget, label = 'UNIPROT-STREAM') {
    return new Promise((resolve, reject) => {
        const child = spawn('zstd', ['-d', '--stdout', '--quiet']);
        const stderrChunks = [];
        const retained = [];
        let recordsSeen = 0;
        let unmatchedUniprot = 0;
        let headerSkipped = 0;
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
            if (t.startsWith('#')) { headerSkipped++; return; }
            let rec;
            try {
                rec = JSON.parse(t);
            } catch (err) {
                // NO SILENT DROP: a malformed record HARD-FAILS with its 1-based index.
                lineError = new Error(
                    `[${label}] JSON parse error in bulk (record #${recordsSeen + 1}): ${err.message} -- aborting (no silent drop)`);
                rl.close();
                try { child.kill(); } catch { /* already gone */ }
                return;
            }
            recordsSeen++;
            if (hitsTarget(rec)) retained.push(rec);
            else unmatchedUniprot++;
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
            resolve({ retained, recordsSeen, unmatchedUniprot, headerSkipped });
        };

        rl.on('close', () => { lineDone = true; maybeFinish(); });
        child.on('close', (code, signal) => {
            // If we deliberately killed the child after a parse error, surface lineError
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
