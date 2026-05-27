/**
 * DailyMed NDC backfill staging promote (PR-RXN-1b-pre-promote, 2026-05-28).
 *
 * One-shot operator-dispatched script. Atomically swaps the live aggregated
 * `processed/aggregated/{latest_run_id}/drug-labels.jsonl` with the hydrated
 * staging payload from `processed/backfill/dailymed-ndcs/{date}/`. THREE
 * invariant assertions enforced before any R2 PUT; any mismatch aborts
 * without state mutation.
 *
 * Architect 2026-05-28 spec (PR-RXN-1b-pre-promote):
 *   - Assertion 1 (record count parity): staging.length === aggregated.length
 *   - Assertion 2 (setid set alignment): every staging setid exists in
 *     aggregated; protects against cold-start data source drift
 *   - Assertion 3 (chronological overwrite guard): abort if
 *     aggregated.run_id > staging.source.run_id (newer aggregated means
 *     business increment landed after staging was made; promoting would
 *     reverse-pollute live state)
 *   - Idempotency: if aggregated already 100% carries non-empty ndcs[],
 *     return idempotent_skipped:true + no-op promote manifest
 *
 * Outputs (R2):
 *   processed/aggregated/{run_id}/drug-labels.jsonl    <- overwritten with hydrated payload
 *   processed/backfill/dailymed-ndcs/{date}/promote-manifest.json   <- audit trail
 *
 * Usage:
 *   node scripts/factory/promote-dailymed-ndc-staging.js
 *     [--staging-date=YYYY-MM-DD]   default: latest backfill date detected
 *     [--dry-run]                   skip R2 PUT; manifest still emitted
 *
 * Exit codes: 0 OK (incl idempotent skip) / 1 args / 2 R2 download
 *             / 3 parity mismatch / 4 setid alignment / 5 chronological guard
 *             / 6 R2 upload
 */

import { createHash } from 'crypto';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const AGG_POINTER_KEY = 'processed/aggregated/latest.json';

export class ParityMismatchException extends Error {
    constructor(message) { super(message); this.name = 'ParityMismatchException'; }
}
export class SetIdAlignmentException extends Error {
    constructor(message) { super(message); this.name = 'SetIdAlignmentException'; }
}
export class ChronologicalGuardException extends Error {
    constructor(message) { super(message); this.name = 'ChronologicalGuardException'; }
}

function parseArgs() {
    const args = { stagingDate: null, dryRun: false };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--staging-date=')) args.stagingDate = a.slice(15);
        else if (a === '--dry-run') args.dryRun = true;
    }
    return args;
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto', endpoint: process.env.R2_ENDPOINT,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function r2Get(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await streamToBuffer(res.Body);
}

async function r2Put(client, bucket, key, body, contentType) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

function zstdDecompressFile(input, output) {
    const r = spawnSync('zstd', ['-d', '-f', '-o', output, input]);
    if (r.error) throw new Error(`zstd decompress: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`zstd exit ${r.status}: ${r.stderr?.toString()}`);
}

function sha256(text) {
    return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function parseJsonl(text) {
    return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/**
 * Three-invariant enforcement. Throws on any mismatch; returns alignment
 * stats on green.
 */
export function enforceInvariants({ aggregatedRecords, stagingRecords, aggregatedRunId, stagingSourceRunId }) {
    if (aggregatedRecords.length !== stagingRecords.length) {
        throw new ParityMismatchException(
            `record count mismatch: staging=${stagingRecords.length} vs aggregated=${aggregatedRecords.length}`
        );
    }
    const aggSetids = new Set(
        aggregatedRecords.filter(r => r?.id?.startsWith?.('sciweon::drug_label::')).map(r => r.setid)
    );
    const stagingDrugLabels = stagingRecords.filter(r => r?.id?.startsWith?.('sciweon::drug_label::'));
    const missing = [];
    for (const r of stagingDrugLabels) {
        if (!aggSetids.has(r.setid)) missing.push(r.setid);
    }
    if (missing.length > 0) {
        throw new SetIdAlignmentException(
            `${missing.length} staging setids missing from aggregated: ${missing.slice(0, 5).join(',')}${missing.length > 5 ? ',...' : ''}`
        );
    }
    // Chronological guard. run_ids are numeric strings from GHA database IDs;
    // monotonically increasing per workflow type.
    if (aggregatedRunId && stagingSourceRunId && Number(aggregatedRunId) > Number(stagingSourceRunId)) {
        throw new ChronologicalGuardException(
            `aggregated run_id ${aggregatedRunId} > staging source run_id ${stagingSourceRunId}; live aggregated has business increment newer than staging`
        );
    }
    return { drugLabelCount: stagingDrugLabels.length, aggregatedSetidCount: aggSetids.size };
}

/**
 * Idempotency check: if aggregated already 100% carries non-empty ndcs[]
 * across all drug_label records, the swap is already done.
 */
export function isAlreadyPromoted(aggregatedRecords) {
    const drugLabels = aggregatedRecords.filter(r => r?.id?.startsWith?.('sciweon::drug_label::'));
    if (drugLabels.length === 0) return false;
    return drugLabels.every(r => Array.isArray(r.ndcs) && r.ndcs.length > 0);
}

async function main() {
    const args = parseArgs();
    const today = new Date().toISOString().slice(0, 10);
    const stagingDate = args.stagingDate ?? today;
    const stagingDir = `processed/backfill/dailymed-ndcs/${stagingDate}`;
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    // Step 1: resolve aggregated pointer.
    let pointerBuf;
    try { pointerBuf = await r2Get(client, bucket, AGG_POINTER_KEY); }
    catch (err) { console.error(`[PROMOTE-NDC] aggregated pointer fetch: ${err.message}`); process.exit(2); }
    const pointer = JSON.parse(pointerBuf.toString('utf-8'));
    const aggregatedRunId = pointer.run_id;
    if (!aggregatedRunId) { console.error('[PROMOTE-NDC] aggregated pointer missing run_id'); process.exit(2); }
    const aggregatedKey = `processed/aggregated/${aggregatedRunId}/drug-labels.jsonl`;
    console.log(`[PROMOTE-NDC] aggregated: ${aggregatedKey} (run_id=${aggregatedRunId})`);

    // Step 2: load aggregated + staging payloads.
    const aggregatedText = (await r2Get(client, bucket, aggregatedKey)).toString('utf-8');
    const aggregatedRecords = parseJsonl(aggregatedText);

    const tmpZst = join(tmpdir(), `promote-ndc-${Date.now()}.jsonl.zst`);
    const tmpJsonl = `${tmpZst}.decoded`;
    let stagingText, stagingSourceRunId;
    try {
        const stagingZst = await r2Get(client, bucket, `${stagingDir}/drug-labels-with-ndcs.jsonl.zst`);
        writeFileSync(tmpZst, stagingZst);
        zstdDecompressFile(tmpZst, tmpJsonl);
        stagingText = readFileSync(tmpJsonl, 'utf-8');
        const stagingManifest = JSON.parse((await r2Get(client, bucket, `${stagingDir}/manifest.json`)).toString('utf-8'));
        stagingSourceRunId = stagingManifest?.source?.run_id ?? null;
        console.log(`[PROMOTE-NDC] staging: ${stagingDir} (source.run_id=${stagingSourceRunId})`);
    } catch (err) {
        console.error(`[PROMOTE-NDC] staging fetch: ${err.message}`);
        process.exit(2);
    } finally {
        for (const p of [tmpZst, tmpJsonl]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
    const stagingRecords = parseJsonl(stagingText);

    // Step 3: idempotency check BEFORE invariants (an already-promoted state
    // would still pass invariants; explicit no-op return is more informative).
    if (isAlreadyPromoted(aggregatedRecords)) {
        const manifest = {
            backfill_target: 'drug-labels.jsonl', execution_timestamp: new Date().toISOString(),
            records_promoted: 0, idempotent_skipped: true,
            aggregated_run_id: aggregatedRunId, staging_source_run_id: stagingSourceRunId,
        };
        console.log(`[PROMOTE-NDC] idempotent skip: aggregated already 100% carries ndcs[]`);
        if (!args.dryRun) {
            await r2Put(client, bucket, `${stagingDir}/promote-manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), 'application/json');
        }
        return;
    }

    // Step 4: enforce three invariants.
    try {
        const stats = enforceInvariants({ aggregatedRecords, stagingRecords, aggregatedRunId, stagingSourceRunId });
        console.log(`[PROMOTE-NDC] invariants green | drug_labels=${stats.drugLabelCount} | aggregated_setid_count=${stats.aggregatedSetidCount}`);
    } catch (err) {
        if (err instanceof ParityMismatchException) { console.error(`[PROMOTE-NDC] ${err.message}`); process.exit(3); }
        if (err instanceof SetIdAlignmentException) { console.error(`[PROMOTE-NDC] ${err.message}`); process.exit(4); }
        if (err instanceof ChronologicalGuardException) { console.error(`[PROMOTE-NDC] ${err.message}`); process.exit(5); }
        throw err;
    }

    // Step 5: write staging payload over aggregated path (or skip on dry-run).
    const stagingHash = sha256(stagingText);
    let destHash = null;
    if (args.dryRun) {
        console.log(`[PROMOTE-NDC] dry-run: skipping R2 PUT to ${aggregatedKey} (staging_sha256=${stagingHash.slice(0, 24)}...)`);
    } else {
        try {
            await r2Put(client, bucket, aggregatedKey, Buffer.from(stagingText, 'utf-8'), 'application/jsonl');
            destHash = sha256(stagingText);
            console.log(`[PROMOTE-NDC] PUT OK: ${aggregatedKey} (${stagingText.length} bytes, sha256=${destHash.slice(0, 24)}...)`);
        } catch (err) { console.error(`[PROMOTE-NDC] R2 PUT: ${err.message}`); process.exit(6); }
    }

    const manifest = {
        backfill_target: 'drug-labels.jsonl', execution_timestamp: new Date().toISOString(),
        records_promoted: stagingRecords.length,
        staging_source_sha256: stagingHash, aggregated_dest_sha256: destHash,
        aggregated_run_id: aggregatedRunId, staging_source_run_id: stagingSourceRunId,
        staging_dir: stagingDir, idempotent_skipped: false, dry_run: args.dryRun,
    };
    if (!args.dryRun) {
        await r2Put(client, bucket, `${stagingDir}/promote-manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), 'application/json');
        console.log(`[PROMOTE-NDC] manifest written: ${stagingDir}/promote-manifest.json`);
    } else {
        console.log(`[PROMOTE-NDC] dry-run manifest: ${JSON.stringify(manifest)}`);
    }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[PROMOTE-NDC] FATAL:', err.message); process.exit(1); });
