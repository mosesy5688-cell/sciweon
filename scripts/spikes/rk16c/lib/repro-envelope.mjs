/**
 * RK-16C FULL-CORPUS SPIKE (D) — REPRODUCIBILITY ENVELOPE recorder (OFFLINE).
 *
 * Captures everything needed to reproduce a run: command line, code SHA
 * (git rev-parse HEAD), Node/runtime version, OS env summary, the corpus
 * identity envelope, the parameter set, the partition policy, run start/end,
 * peak heap, temp-disk usage, and the output hashes. NO undocumented local
 * state: every input the run depended on is named here.
 *
 * It NEVER records credentials (env summary lists only NON-secret keys + the
 * presence/absence of secret-shaped keys, never their values).
 */

import { execSync } from 'child_process';

/** git rev-parse HEAD (best-effort; null if git is unavailable). */
export function codeSha(cwd = process.cwd()) {
    try {
        return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim();
    } catch { return null; }
}

const SECRET_RE = /(secret|token|key|password|credential|access[_-]?key)/i;

/** OS + runtime summary WITHOUT any secret values. */
export function envSummary() {
    const secretKeysPresent = Object.keys(process.env)
        .filter((k) => SECRET_RE.test(k))
        .sort();
    return {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu_count: (() => { try { return require('os').cpus().length; } catch { return null; } })(),
        // ONLY the NAMES of secret-shaped env keys are recorded, NEVER values.
        secret_shaped_env_keys_present: secretKeysPresent,
    };
}

/** Begin an envelope. `corpusIdentity` is the (proposed or verified) envelope. */
export function startEnvelope(opts = {}) {
    return {
        rubric_version: opts.rubricVersion || null,
        command_line: opts.commandLine || process.argv.join(' '),
        code_sha: codeSha(opts.cwd),
        runtime: envSummary(),
        corpus_identity: opts.corpusIdentity || null,
        parameter_set: opts.parameterSet || null,
        partition_policy: opts.partitionPolicy || null,
        run_started_at: new Date().toISOString(),
        run_ended_at: null,
        peak_heap_bytes: null,
        temp_disk_bytes: null,
        output_hashes: {},
        undocumented_local_state: 'none — all inputs named above',
    };
}

/** Finalize an envelope: record end time, peak heap, temp usage, output hashes. */
export function endEnvelope(env, opts = {}) {
    env.run_ended_at = new Date().toISOString();
    env.peak_heap_bytes = opts.peakHeapBytes != null
        ? opts.peakHeapBytes
        : process.memoryUsage().heapUsed;
    env.temp_disk_bytes = opts.tempDiskBytes != null ? opts.tempDiskBytes : null;
    env.output_hashes = opts.outputHashes || {};
    return env;
}

/** Current heap usage sample (callers poll this around the matrix run). */
export function heapSample() {
    return process.memoryUsage().heapUsed;
}
