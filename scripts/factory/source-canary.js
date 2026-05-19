/**
 * V0.5.8 Wave I-5 — daily V2 adapter live canary.
 *
 * For each V2 adapter, dynamically imports the module and calls
 * checkForUpdates(null) with a 20s timeout. Records pass/fail + duration
 * + response shape. Writes ./output/canary-report.json for the workflow
 * to consume.
 *
 * Idempotent. Read-only against R2 (state load/save is done by the
 * workflow via lib/r2-cache-bridge.js).
 *
 * Usage:
 *   npm run canary
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve('./output');
const REPORT_PATH = path.join(OUTPUT_DIR, 'canary-report.json');
const PROBE_TIMEOUT_MS = 20000;

const ADAPTERS = [
    'clinicaltrials',
    'pubmed',
    'openalex',
    'ctis',
    'chembl',
    'nci-thesaurus',
    'retraction-watch',
];

async function probeOne(source) {
    const start = Date.now();
    let mod;
    try {
        const adapterPath = path.resolve(__dirname, `../ingestion/adapters/${source}-adapter.js`);
        mod = await import(adapterPath);
    } catch (err) {
        return {
            source,
            passed: false,
            error: `import failed: ${err?.message ?? String(err)}`,
            duration_ms: Date.now() - start,
        };
    }
    if (typeof mod.checkForUpdates !== 'function') {
        return {
            source,
            passed: false,
            error: 'no V2 checkForUpdates export',
            duration_ms: Date.now() - start,
        };
    }
    try {
        const probe = mod.checkForUpdates(null);
        const result = await Promise.race([
            probe,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`canary timeout after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)),
        ]);
        const duration_ms = Date.now() - start;
        if (typeof result?.hasUpdates !== 'boolean') {
            return { source, passed: false, error: 'malformed response (no hasUpdates boolean)', duration_ms };
        }
        return {
            source,
            passed: true,
            duration_ms,
            hasUpdates: result.hasUpdates,
            count: result.count ?? null,
        };
    } catch (err) {
        return {
            source,
            passed: false,
            error: err?.message ?? String(err),
            duration_ms: Date.now() - start,
        };
    }
}

async function main() {
    console.log(`[CANARY] Probing ${ADAPTERS.length} V2 adapters with checkForUpdates(null)...`);
    const startAt = new Date().toISOString();

    const results = await Promise.all(ADAPTERS.map(probeOne));

    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;

    const report = {
        generated_at: startAt,
        adapter_count: ADAPTERS.length,
        passed,
        failed,
        threshold_ms: PROBE_TIMEOUT_MS,
        adapters: results,
    };

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

    // Pretty-print summary table
    console.log('[CANARY] Results:');
    for (const r of results) {
        const status = r.passed ? 'PASS' : 'FAIL';
        const detail = r.passed
            ? `hasUpdates=${r.hasUpdates} count=${r.count ?? '?'}`
            : `error="${r.error}"`;
        console.log(`  ${status.padEnd(4)}  ${r.source.padEnd(20)} ${r.duration_ms}ms  ${detail}`);
    }
    console.log(`[CANARY] ${passed}/${results.length} pass · ${failed}/${results.length} fail`);
    console.log(`[CANARY] Report written to ${REPORT_PATH}`);

    // Always exit 0 — workflow decides Issue/no-Issue based on report.json.
    // Failing the workflow on canary would be noisy; the Issue is the surface.
}

main().catch(err => {
    console.error('[CANARY] Fatal:', err);
    process.exit(1);
});
