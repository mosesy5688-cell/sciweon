/**
 * DailyMed Harvest — Sciweon V0.5.4
 *
 * Standalone runner for the DailyMed adapter v2. Reads the per-source cursor
 * from R2, calls checkForUpdates → fetchIncremental, writes DrugLabel entities
 * to output/linked/drug-labels.jsonl, uploads to R2, and advances the cursor.
 *
 * This is the reference implementation for V0.7 incremental worker pattern.
 * When V0.7 factory-incremental-daily.yml lands, DailyMed will run as one of
 * 14+ parallel matrix workers via incremental-worker.js --source=dailymed.
 * Until then, this standalone runner provides manual + GHA dispatch coverage.
 *
 * R2 cursor key:   state/incremental-cursors/dailymed.json
 * R2 output key:   processed/dailymed/{run_id}/drug-labels.jsonl
 *
 * CLI args:
 *   --since=YYYY-MM-DD   Override cursor sinceToken (skips R2 cursor read)
 *   --dry-run            Fetch + count labels without writing any output
 *   --limit=N            Cap label count (useful for smoke-testing)
 *
 * Exit codes:
 *   0  success (or no updates)
 *   1  fatal error
 */

import { checkForUpdates, fetchIncremental } from '../ingestion/adapters/dailymed-adapter.js';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';

const CURSOR_KEY  = 'state/incremental-cursors/dailymed.json';
const OUTPUT_DIR  = './output/linked';
const OUTPUT_FILE = 'drug-labels.jsonl';

// ─── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs() {
    const result = { since: null, dryRun: false, limit: Infinity };
    for (const arg of process.argv.slice(2)) {
        if (!arg.startsWith('--')) continue;
        const [k, v] = arg.slice(2).split('=');
        if (k === 'since')    result.since   = v ?? null;
        if (k === 'dry-run')  result.dryRun  = true;
        if (k === 'limit' && v) result.limit = parseInt(v, 10) || Infinity;
    }
    return result;
}

// ─── R2 helpers ─────────────────────────────────────────────────────────────

function makeR2() {
    const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
    return {
        client: new S3Client({
            endpoint: R2_ENDPOINT,
            region: 'auto',
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY,
            },
        }),
        bucket: R2_BUCKET,
    };
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function r2Get(r2, key) {
    const res = await r2.client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
    return streamToBuffer(res.Body);
}

async function r2Put(r2, key, body, contentType = 'application/octet-stream') {
    await r2.client.send(new PutObjectCommand({
        Bucket: r2.bucket, Key: key,
        Body: typeof body === 'string' ? Buffer.from(body, 'utf-8') : body,
        ContentType: contentType,
    }));
}

// ─── Cursor management ───────────────────────────────────────────────────────

async function readCursor(r2) {
    if (!r2) return { sinceToken: null, last_run_at: null, total_collected: 0 };
    try {
        const buf = await r2Get(r2, CURSOR_KEY);
        return JSON.parse(buf.toString());
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
            console.log('[CURSOR] No dailymed cursor in R2 — bootstrapping');
            return { sinceToken: null, last_run_at: null, total_collected: 0 };
        }
        throw new Error(`[CURSOR] Failed to read: ${e.message}`);
    }
}

async function writeCursor(r2, cursor) {
    if (!r2) {
        console.log('[CURSOR] No R2 configured — cursor not persisted');
        return;
    }
    await r2Put(r2, CURSOR_KEY, JSON.stringify(cursor, null, 2), 'application/json');
    console.log(`[CURSOR] Written: sinceToken=${cursor.sinceToken} total=${cursor.total_collected}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();
    console.log('[DAILYMED-HARVEST] Sciweon V0.5.4 DailyMed adapter v2');
    if (args.dryRun) console.log('[DAILYMED-HARVEST] DRY RUN — no writes');

    const r2 = makeR2();
    if (!r2) console.log('[DAILYMED-HARVEST] R2 not configured — local-only run');

    // Resolve sinceToken: CLI override → R2 cursor → null (bootstrap)
    const cursor = await readCursor(r2);
    const sinceToken = args.since ?? cursor.sinceToken ?? null;

    console.log(`[DAILYMED-HARVEST] sinceToken=${sinceToken ?? '(bootstrap: 7 days ago)'} limit=${args.limit === Infinity ? 'unlimited' : args.limit}`);

    // Phase 1: check for updates
    const { hasUpdates, count } = await checkForUpdates(sinceToken);
    console.log(`[DAILYMED-HARVEST] ${count} labels available (hasUpdates=${hasUpdates})`);

    if (!hasUpdates) {
        console.log('[DAILYMED-HARVEST] No updates since last run — exiting 0');
        process.exit(0);
    }

    // Phase 2: fetch labels
    const { records, nextSinceToken } = await fetchIncremental(sinceToken, args.limit);
    console.log(`[DAILYMED-HARVEST] ${records.length} drug labels returned`);

    if (records.length === 0) {
        console.log('[DAILYMED-HARVEST] Zero records after filter — cursor NOT advanced');
        process.exit(0);
    }

    const jsonl = records.map(r => JSON.stringify(r)).join('\n');

    if (args.dryRun) {
        console.log('[DAILYMED-HARVEST] DRY RUN complete — no writes');
        console.log(`  Would write: ${records.length} labels`);
        const sample = records[0];
        if (sample) {
            console.log(`  Sample id:   ${sample.id}`);
            console.log(`  Sample type: ${sample.label_type}`);
            console.log(`  Sections extracted: ${sample.sections_extracted}`);
            const sectionNames = Object.entries(sample.sections ?? {})
                .filter(([, v]) => v !== null)
                .map(([k]) => k);
            console.log(`  Sections with content: [${sectionNames.join(', ')}]`);
        }
        process.exit(0);
    }

    // Phase 3: write local output
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const localPath = path.join(OUTPUT_DIR, OUTPUT_FILE);
    await fs.writeFile(localPath, jsonl, 'utf-8');
    console.log(`[DAILYMED-HARVEST] Wrote ${localPath} (${records.length} records, ${(jsonl.length / 1024).toFixed(1)} KB)`);

    // Phase 4: upload to R2
    if (r2) {
        const runId = `${Date.now()}`;
        const r2Key = `processed/dailymed/${runId}/drug-labels.jsonl`;
        await r2Put(r2, r2Key, jsonl, 'application/x-ndjson');
        console.log(`[DAILYMED-HARVEST] Uploaded R2 ${r2Key}`);
    }

    // Phase 5: advance cursor (only after successful write)
    const newCursor = {
        sinceToken: nextSinceToken,
        last_run_at: new Date().toISOString(),
        total_collected: (cursor.total_collected ?? 0) + records.length,
    };
    await writeCursor(r2, newCursor);

    console.log(`[DAILYMED-HARVEST] Complete: ${records.length} labels | next sinceToken=${nextSinceToken}`);
}

main().catch(e => {
    console.error('[DAILYMED-HARVEST] Fatal:', e);
    process.exit(1);
});
