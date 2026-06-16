/**
 * RK-16C FULL-CORPUS SUPPLEMENTAL SPIKE (E) — runner entrypoint.
 *
 * Re-validates page-size + partition selection at production scale. BUILD-ONLY:
 * by DEFAULT it performs NO network read — it prints the EXACT proposed
 * production object keys + estimated request count + total bytes from the pinned
 * corpus identity, then runs the FULL 12-cell matrix (128/256/512/1024 x
 * P0/P1/P2) against a FIXTURE (local 2026-05-13 corpus if present, else a
 * synthetic fixture, LABELED) and judges every cell with the pre-registered
 * rubric. It does NOT fetch the 475k corpus, register a family, or write R2.
 *
 *   DRY-RUN (default):  node scripts/spikes/rk16c/run-fullcorpus.mjs
 *   CLEANUP:            node scripts/spikes/rk16c/run-fullcorpus.mjs --cleanup
 *
 * CONTROL FLOW: parseArgs -> selectAction(args) (pure state matrix) -> dispatch.
 *   - no flags            -> BUILD fixture matrix (zero network)
 *   - --preflight only    -> dry-run plan only (zero network, NO matrix)
 *   - --preflight --execute (with the exact --manifest-key for --snapshot)
 *                         -> metadata-only preflightManifest via runPreflight()
 *   - generic --execute   -> REFUSED before any client (the full-run/payload path
 *                            is CLI-UNREACHABLE; only --preflight --execute runs).
 * The full-run adapter symbol is NOT imported in this runner by design.
 *
 *   PREFLIGHT (metadata-only): node scripts/spikes/rk16c/run-fullcorpus.mjs --preflight --execute --snapshot 2026-06-14/27502029137-1 --manifest-key snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeDryRunPlan, cleanup } from './lib/r2-readonly-adapter.mjs';
import { CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT } from './lib/corpus-identity.mjs';
import { selectAction, runPreflight } from './lib/preflight-control.mjs';
import { resolveFixture } from './lib/fixture-source.mjs';
import { buildCell, RECORD_TARGETS, PARTITION_POLICIES } from './lib/fullcorpus-cells.mjs';
import { PARTITION_STRATEGIES } from './lib/policy.mjs';
import { realDegreeReport } from './lib/real-degree.mjs';
import { selectCandidate, assertMetricsComplete, RUBRIC_VERSION } from './lib/rubric.mjs';
import { startEnvelope, endEnvelope, heapSample, codeSha } from './lib/repro-envelope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, 'results');
const SNAPSHOT_IDENTITY = `${CANDIDATE_SNAPSHOT_ID} (fixture-mode label)`;

function parseArgs(argv) {
    const a = { dryRun: true, execute: false, preflight: false, cleanup: false, snapshot: CANDIDATE_SNAPSHOT_ID, expectedRows: EXPECTED_ROW_COUNT };
    for (let i = 2; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--execute') { a.execute = true; a.dryRun = false; }
        else if (t === '--preflight') a.preflight = true;
        else if (t === '--dry-run') a.dryRun = true;
        else if (t === '--cleanup') a.cleanup = true;
        else if (t === '--snapshot') a.snapshot = argv[++i];
        else if (t === '--manifest-key') a.manifestKey = argv[++i];
        else if (t === '--lock') a.lockPath = argv[++i];
        else if (t === '--expected-rows') a.expectedRows = Number(argv[++i]);
    }
    return a;
}

/** Run the full 12-cell matrix over fixture projection rows. */
export async function runMatrix(proj, outputDir) {
    const cells = [];
    for (const rt of RECORD_TARGETS) {
        for (const pkey of PARTITION_POLICIES) {
            const strat = PARTITION_STRATEGIES[pkey];
            const id = `rt${rt}_${strat.name}`;
            const cell = await buildCell(
                id, proj, rt, strat.of, outputDir, `cell_${id}`, SNAPSHOT_IDENTITY);
            assertMetricsComplete(cell.metrics);
            cells.push(cell);
        }
    }
    return cells;
}

async function main() {
    const args = parseArgs(process.argv);
    const { action, reason } = selectAction(args);

    if (action === 'cleanup') {
        const r = cleanup(args.snapshot);
        console.log('[rk16c-fullcorpus] cleanup:', JSON.stringify(r));
        return;
    }

    if (action === 'execute-refused' || action === 'fail-closed') {
        // Construct NO client; the full-run/payload path is never invoked here.
        console.error(`\n[rk16c-fullcorpus] REFUSED (${action}): ${reason}`);
        console.error('[rk16c-fullcorpus] The full-run/payload path is CLI-UNREACHABLE from this runner; only `--preflight --execute --manifest-key <exact key>` is permitted (metadata-only).');
        process.exit(2);
        return;
    }

    if (action === 'preflight-execute') {
        await runPreflight(args); // REAL deps built lazily; reaches preflightManifest only.
        return;
    }

    // 'dry-run-matrix' and 'preflight-plan' both compute + print the dry-run plan.
    const dryRun = computeDryRunPlan({
        snapshot: args.snapshot, expectedRows: args.expectedRows, buildCommit: codeSha(),
    });
    console.log('\n===== RK-16C FULL-CORPUS DRY-RUN PLAN (NO NETWORK) =====');
    console.log(JSON.stringify(dryRun, null, 2));

    if (action === 'preflight-plan') {
        console.log('\n[rk16c-fullcorpus] --preflight (no --execute): dry-run plan only — NO matrix, NO network, NO candidate lock.');
        return;
    }

    // 'dry-run-matrix': fixture matrix + real-degree + rubric (NO 475k fetch).
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk16c-fc-'));
    const env = startEnvelope({
        rubricVersion: RUBRIC_VERSION, corpusIdentity: dryRun.identity_envelope,
        parameterSet: { record_targets: RECORD_TARGETS, partition_policies: PARTITION_POLICIES },
        partitionPolicy: 'P0/P1/P2',
    });

    const fx = await resolveFixture({ outputDir });
    console.log(`\n[rk16c-fullcorpus] BUILD fixture: ${fx.label} (${fx.record_count} rows)`);

    const heapBefore = heapSample();
    const cells = await runMatrix(fx.proj, outputDir);
    const degree = realDegreeReport(fx.rows, { corpus_grounded: fx.corpus_grounded });
    const selection = selectCandidate(cells);
    const peak = Math.max(heapBefore, heapSample());

    endEnvelope(env, {
        peakHeapBytes: peak, tempDiskBytes: dirSize(outputDir),
        outputHashes: { cell_count: cells.length },
    });

    const out = {
        phase: 'BUILD', mode: 'dry-run', generated_at: new Date().toISOString(),
        dry_run_plan: dryRun, fixture: { label: fx.label, source: fx.source, record_count: fx.record_count, corpus_grounded: fx.corpus_grounded },
        matrix_cells: cells, real_degree: degree, rubric_selection: selection,
        reproducibility_envelope: env,
    };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, 'rk16c-fullcorpus-results.json'), JSON.stringify(out, null, 2));
    fs.rmSync(outputDir, { recursive: true, force: true });

    console.log(`\n[rk16c-fullcorpus] matrix cells: ${cells.length} (>=12 required)`);
    console.log(`[rk16c-fullcorpus] rubric outcome: ${selection.outcome} (ratifiable=${selection.ratifiable})`);
    console.log('[rk16c-fullcorpus] DONE — BUILD-only, NO network, results under results/.');
}

function dirSize(dir) {
    let total = 0;
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
        }
    };
    try { walk(dir); } catch { /* best-effort */ }
    return total;
}

const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
