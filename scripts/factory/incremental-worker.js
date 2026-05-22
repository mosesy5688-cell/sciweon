/**
 * V0.7 Incremental Worker — per-source orchestrator.
 *
 * Flow: read R2 cursor → checkForUpdates (fast probe, <1 min) → early exit
 * if no updates → fetchIncremental → gzip → write to R2 staging → advance cursor.
 *
 * Called by factory-incremental-daily.yml matrix:
 *   node incremental-worker.js --source=dailymed [--run-id=YYYY-MM-DD] [--dry-run]
 *
 * Adapter V2 contract (scripts/ingestion/adapters/{source}-adapter.js must export):
 *   checkForUpdates(sinceToken) -> { hasUpdates, count?, nextSinceToken }
 *   fetchIncremental(sinceToken) -> { records[], nextSinceToken }
 *   supportsIncremental (boolean)
 *
 * Sources without a V2 adapter are skipped with exit 0 (no failure cascade).
 */

import { gzipSync } from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
    makeIncrementalR2, readIncrementalCursor, writeIncrementalCursor,
} from './lib/incremental-cursors.js';
import { decideCursorAdvance } from './lib/incremental-cursor-decision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGING_PREFIX = 'staging/incremental';

function parseArgs() {
    const args = process.argv.slice(2);
    const source = args.find(a => a.startsWith('--source='))?.split('=')[1];
    const runId  = args.find(a => a.startsWith('--run-id='))?.split('=')[1]
        ?? new Date().toISOString().slice(0, 10);
    const dryRun = args.includes('--dry-run');
    if (!source) throw new Error('--source=<name> is required');
    return { source, runId, dryRun };
}

async function loadAdapterV2(source) {
    // __dirname = scripts/factory/ → ../ingestion/adapters/ = scripts/ingestion/adapters/
    const p = path.resolve(__dirname, `../ingestion/adapters/${source}-adapter.js`);
    try {
        const mod = await import(p);
        if (typeof mod.checkForUpdates !== 'function' || typeof mod.fetchIncremental !== 'function') {
            console.log(`[WORKER:${source}] Adapter exists but not V2 — skip`);
            return null;
        }
        return mod;
    } catch (err) {
        console.log(`[WORKER:${source}] No adapter found — skip (${err.message})`);
        return null;
    }
}

async function stageDelta(client, bucket, source, runId, records, dryRun) {
    const raw = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const gz  = gzipSync(raw, { level: 9 });
    const key = `${STAGING_PREFIX}/${source}/${runId}/${source}.jsonl.gz`;
    if (!dryRun) {
        await client.send(new PutObjectCommand({
            Bucket: bucket, Key: key, Body: gz, ContentType: 'application/gzip',
        }));
    }
    console.log(`[WORKER:${source}] ${dryRun ? '[dry] ' : ''}staged ${records.length} records → ${key}`);
}

async function runWorker(source, client, bucket, runId, dryRun) {
    const adapter = await loadAdapterV2(source);
    if (!adapter) return;

    const cursor     = await readIncrementalCursor(client, bucket, source);
    const sinceToken = cursor?.sinceToken ?? null;

    console.log(`[WORKER:${source}] checkForUpdates sinceToken=${sinceToken}`);
    const check = await adapter.checkForUpdates(sinceToken);
    console.log(`[WORKER:${source}] hasUpdates=${check.hasUpdates} count=${check.count ?? '?'}`);

    if (!check.hasUpdates) {
        // Pattern A2 (cycle 21): probe-path early-exit must HOLD the cursor.
        // DailyMed/WHO-ATC return nextSinceToken=today regardless — trusting
        // it permanently locks the cursor. See incremental-cursor-decision.js.
        const decision = decideCursorAdvance({
            recordsLength: 0,
            currentSinceToken: sinceToken,
            nextSinceToken: check.nextSinceToken,
            source,
            hasUpdates: false,
        });
        if (!dryRun) {
            await writeIncrementalCursor(client, bucket, source, {
                ...(cursor ?? {}),
                ...decision.cursorUpdate,
                last_run_at: new Date().toISOString(),
                supportsIncremental: adapter.supportsIncremental ?? true,
            });
        }
        console.log(`[WORKER:${source}] No updates — cursor held at ${sinceToken} (status=no_updates)`);
        return;
    }

    const { records, nextSinceToken } = await adapter.fetchIncremental(sinceToken);
    console.log(`[WORKER:${source}] fetched ${records.length} records`);

    if (records.length > 0) await stageDelta(client, bucket, source, runId, records, dryRun);

    const decision = decideCursorAdvance({
        recordsLength: records.length,
        currentSinceToken: sinceToken,
        nextSinceToken,
        source,
    });

    if (decision.kind === 'anomaly_zero_fetch_hold') {
        console.warn(`[WORKER:${source}] ${decision.message}`);
    }

    if (!dryRun) {
        const now = new Date().toISOString();
        // last_success_at: only stamped when records actually fetched + staged.
        // Health-monitor uses this to detect stalled sources (cursor written
        // every run, but last_success_at frozen for >threshold = drift signal).
        const successFields = decision.kind === 'advance' ? { last_success_at: now } : {};
        await writeIncrementalCursor(client, bucket, source, {
            ...(cursor ?? {}),
            ...decision.cursorUpdate,
            ...successFields,
            last_run_at: now,
            supportsIncremental: adapter.supportsIncremental ?? true,
        });
        if (decision.kind === 'advance') {
            console.log(`[WORKER:${source}] Cursor advanced → ${nextSinceToken}`);
        } else {
            console.log(`[WORKER:${source}] Cursor HELD at ${sinceToken} (status=anomaly_zero_fetch)`);
        }
    }
}

async function main() {
    const { source, runId, dryRun } = parseArgs();
    console.log(`[WORKER:${source}] V0.7 — runId=${runId}${dryRun ? ' [dry-run]' : ''}`);

    const r2 = makeIncrementalR2();
    if (!r2) {
        console.warn(`[WORKER:${source}] R2 not configured — dry-run mode`);
        const adapter = await loadAdapterV2(source);
        if (!adapter) return;
        const check = await adapter.checkForUpdates(null);
        console.log(`[WORKER:${source}] check (no-R2): ${JSON.stringify(check)}`);
        return;
    }

    const { client, bucket } = r2;
    try {
        await runWorker(source, client, bucket, runId, dryRun);
        console.log(`[WORKER:${source}] Done`);
    } catch (err) {
        console.error(`[WORKER:${source}] Fatal: ${err.message}`);
        try {
            const cur = await readIncrementalCursor(client, bucket, source);
            await writeIncrementalCursor(client, bucket, source, {
                ...(cur ?? {}),
                status: 'failed',
                error_message: err.message,
                last_run_at: new Date().toISOString(),
            });
        } catch { /* non-fatal */ }
        process.exit(1);
    }
}

main().catch(err => { console.error('[WORKER] Fatal:', err); process.exit(1); });
