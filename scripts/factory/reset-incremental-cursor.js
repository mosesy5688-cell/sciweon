/**
 * Cycle 21 — one-time incremental cursor reset.
 *
 * Use after the worker cursor-poisoning fix to force a source (or sources)
 * to bootstrap on the next scheduled run. Without a reset, two adapter
 * cases linger:
 *   - DailyMed: cursor=today → probe asks "labels since today" → 0 daily →
 *     hold forever. Reset → null → bootstrapSince() = today-7d → fetches.
 *   - WHO-ATC: cursor=today → daysSince=0 < 30 → hasUpdates=false → hold
 *     until 30 days elapse. Reset → null → daysSince=Infinity → fetches.
 *
 * R2 layout: state/incremental-cursors/<source>.json
 * Modes:
 *   --source=a,b,c            Reset listed sources (sinceToken=null)
 *   --source=a --hard         Delete the cursor object outright (full bootstrap)
 *   --dry-run                 Print plan, don't write
 *
 * Per `feedback_no_backend_workflow_dispatch`, AI must not dispatch this
 * workflow. User invokes manually via the matching GHA workflow_dispatch.
 */

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
    makeIncrementalR2, readIncrementalCursor, writeIncrementalCursor,
} from './lib/incremental-cursors.js';

const CURSOR_PREFIX = 'state/incremental-cursors';

function parseArgs() {
    const args = process.argv.slice(2);
    const sourcesArg = args.find(a => a.startsWith('--source='))?.split('=')[1] ?? '';
    const sources = sourcesArg.split(',').map(s => s.trim()).filter(Boolean);
    const hard = args.includes('--hard');
    const dryRun = args.includes('--dry-run');
    if (sources.length === 0) {
        throw new Error('--source=<name>[,name...] is required');
    }
    return { sources, hard, dryRun };
}

async function main() {
    const { sources, hard, dryRun } = parseArgs();
    console.log(`[RESET-CURSOR] sources=${sources.join(',')} hard=${hard} dryRun=${dryRun}`);

    const r2 = makeIncrementalR2();
    if (!r2) {
        console.error('[RESET-CURSOR] R2 not configured');
        process.exit(1);
    }
    const { client, bucket } = r2;

    for (const source of sources) {
        const before = await readIncrementalCursor(client, bucket, source);
        console.log(`[RESET-CURSOR] ${source}: before = ${JSON.stringify(before)}`);

        if (dryRun) {
            console.log(`[RESET-CURSOR] ${source}: [dry-run] would ${hard ? 'DELETE' : 'reset sinceToken=null'}`);
            continue;
        }

        if (hard) {
            await client.send(new DeleteObjectCommand({
                Bucket: bucket, Key: `${CURSOR_PREFIX}/${source}.json`,
            }));
            console.log(`[RESET-CURSOR] ${source}: cursor object deleted`);
        } else {
            await writeIncrementalCursor(client, bucket, source, {
                ...(before ?? {}),
                sinceToken: null,
                status: 'reset',
                record_count: 0,
                last_run_at: new Date().toISOString(),
            });
            console.log(`[RESET-CURSOR] ${source}: sinceToken cleared (status=reset)`);
        }
    }
    console.log('[RESET-CURSOR] Done');
}

main().catch(err => {
    console.error('[RESET-CURSOR] Fatal:', err.message);
    process.exit(1);
});
