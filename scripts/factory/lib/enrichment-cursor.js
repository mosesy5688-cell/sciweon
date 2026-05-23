/**
 * Enrichment cursor - cycle 22 PR-CORE-2 substrate.
 *
 * Per-source R2 cursor at `state/enrichment-cursor/<source>.json` lets each
 * enricher process a chunk of the cumulative bundle per stage-2 cycle and
 * resume from where the previous cycle left off. Replaces the prior
 * head-of-array-only churn pattern (PR-CORE-1 baseline showed 4 sources
 * stuck < 50% because stage-2 walltime exhausted before tail was reached).
 *
 * Triple-lock anchor (per [[no_shortcut_in_science]]):
 *   - scale: cursor advances every cycle; full coverage in O(N/chunk_size).
 *   - quality: stable lex-sort by `id` is deterministic across runs even as
 *     bundle grows; cursor failures bubble up (no silent skip per
 *     [[cross_cycle_silent_data_loss]]).
 *   - relational structure: cursor JSON is the contract between PR-CORE-1
 *     measurement (state/source-completeness.json) and PR-CORE-2
 *     remediation (this module + per-source enricher integrations).
 *
 * Cursor JSON shape:
 * {
 *   source: 'rxnorm',
 *   cursor_id: 'sciweon::compound::CID:32145' | null,
 *   chunk_size: 5000,
 *   processed_in_run: 5000,
 *   cycles_completed: 0,
 *   last_run: '2026-05-23T...',
 *   total_eligible_at_last_run: 24824
 * }
 *
 * cursor_id semantics: lex-greatest id processed in the previous cycle.
 * Next cycle reads records with id > cursor_id. When the slice is shorter
 * than chunk_size, cursor wraps to null (start over) and cycles_completed
 * is incremented.
 *
 * Default chunk_size is 5000 (~20 min @ 250 ms per record). Per-source
 * override stored in the cursor JSON itself.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
export const DEFAULT_CHUNK_SIZE = 5000;

function cursorKey(source) {
    return `state/enrichment-cursor/${source}.json`;
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length > 0) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

// Read cursor for source; null when no cursor exists yet (first run).
// Network/IO failures bubble up - the script must decide whether to
// fall back to a fresh cursor or abort.
export async function readCursor(source) {
    const client = makeR2Client();
    try {
        const res = await client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: cursorKey(source),
        }));
        const buf = await streamToBuffer(res.Body);
        return JSON.parse(buf.toString());
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return null;
        }
        throw err;
    }
}

export async function writeCursor(source, cursor) {
    const client = makeR2Client();
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: cursorKey(source),
        Body: JSON.stringify(cursor, null, 2),
        ContentType: 'application/json',
    }));
}

// Pure function: pick the next chunk from a record array.
// - records: array of {id: string, ...}
// - cursor: null or {cursor_id: string|null, ...}
// - chunkSize: positive integer
// Returns {slice, nextCursorId, wrapped, totalEligible}.
//   slice: records to process this cycle (length <= chunkSize)
//   nextCursorId: the id to persist for next cycle (or null if wrapped)
//   wrapped: true iff the slice exhausted the tail and wrapped to start
//   totalEligible: records.length (caller may have pre-filtered by gate)
export function chunkIterator(records, cursor, chunkSize = DEFAULT_CHUNK_SIZE) {
    if (!Array.isArray(records)) throw new Error('chunkIterator: records must be array');
    if (!(chunkSize > 0)) throw new Error('chunkIterator: chunkSize must be > 0');
    const sorted = [...records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const cursorId = cursor?.cursor_id ?? null;
    let startIdx = 0;
    if (cursorId != null) {
        startIdx = sorted.findIndex(r => String(r.id) > cursorId);
        if (startIdx === -1) startIdx = sorted.length;
    }
    const remaining = sorted.length - startIdx;
    if (remaining >= chunkSize) {
        const slice = sorted.slice(startIdx, startIdx + chunkSize);
        return {
            slice,
            nextCursorId: String(slice[slice.length - 1].id),
            wrapped: false,
            totalEligible: sorted.length,
        };
    }
    // Tail shorter than chunkSize - take the tail then wrap to start.
    // Cap total at sorted.length so we never duplicate records when
    // chunkSize > corpus (an over-sized chunk processes each record once
    // and reports wrapped=true).
    const tail = sorted.slice(startIdx);
    const needed = Math.min(chunkSize - tail.length, sorted.length - tail.length);
    const head = needed > 0 ? sorted.slice(0, needed) : [];
    const slice = [...tail, ...head];
    let nextCursorId = null;
    if (head.length > 0) nextCursorId = String(head[head.length - 1].id);
    else if (tail.length > 0) nextCursorId = String(tail[tail.length - 1].id);
    return {
        slice,
        nextCursorId,
        wrapped: true,
        totalEligible: sorted.length,
    };
}

// Build the cursor object to persist after an enrichment chunk completes.
// Caller passes the previous cursor (may be null), chunk result, and
// the per-source attempted count for telemetry.
export function buildNextCursor({ source, prev, chunkResult, processedCount, totalEligible }) {
    const cyclesCompleted = (prev?.cycles_completed ?? 0) + (chunkResult.wrapped ? 1 : 0);
    return {
        source,
        cursor_id: chunkResult.nextCursorId,
        chunk_size: prev?.chunk_size ?? DEFAULT_CHUNK_SIZE,
        processed_in_run: processedCount,
        cycles_completed: cyclesCompleted,
        last_run: new Date().toISOString(),
        total_eligible_at_last_run: totalEligible,
    };
}
