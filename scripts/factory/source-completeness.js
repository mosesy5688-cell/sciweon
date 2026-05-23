/**
 * Source Completeness V1 (cycle 22 PR-CORE-1) - Pattern E tracker entry.
 *
 * Per-source x tier-class completeness audit. Scans the latest aggregated
 * bundle (compounds-enriched.jsonl / bioactivities.jsonl / drug-labels.jsonl)
 * and computes, for each of 8 V1 sources, the fraction of records where
 * every required field per SOURCE_REQUIRED_FIELDS is non-null ("strict
 * enriched" semantic).
 *
 * Sibling to snapshot-completeness.js (Layer 4 time-dimension audit).
 * This script measures the content-dimension complement: within each
 * snapshot, how complete is each source's enrichment.
 *
 * Why: PR-CORE-2 (proactive systematic enrichment) needs per-source
 * gate-adjusted completeness to prioritize which records to enrich next.
 * Without this signal PR-CORE-2 would fall back to lazy promotion, one
 * of the 5 banned shortcut patterns under [[no-shortcut-in-science]].
 *
 * Usage:
 *   node source-completeness.js [--run-id=<id>]
 *
 * --run-id is optional. Default = latest aggregated run via the standard
 * pointer at processed/aggregated/latest.json.
 *
 * Exit codes:
 *   0  all 8 sources gate_adjusted_pct >= 95 (healthy)
 *   1  HARDFAIL - any source gate_adjusted_pct < 50 (catastrophic drop)
 *   2  WARN - any source gate_adjusted_pct < 80 (PR-CORE-2 priority)
 *   3  INFO - any source gate_adjusted_pct < 95 (low-priority gap)
 *   4  R2 access failure
 *
 * Output:
 *   R2 state/source-completeness.json - per-source stats. Consumed by
 *   PR-CORE-2 prioritization and dashboards.
 */

import readline from 'readline';
import { Readable } from 'stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SOURCE_REQUIRED_FIELDS, SEVERITY_THRESHOLDS, filesNeeded } from './lib/source-required-fields.js';
import {
    pct, initStat, scanFile, severityTierForPct, aggregateSeverity, listBelowThreshold,
} from './lib/source-completeness-helpers.js';
// SEVERITY_THRESHOLDS still imported for the final HARDFAIL log line
// (uses the GLOBAL hardfail threshold in the message - per-source values
// are reflected in the per-source tier label printed by printSummary).

const STATE_KEY = 'state/source-completeness.json';
const POINTER_KEY = 'processed/aggregated/latest.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function parseArgs() {
    let runIdOverride = null;
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--run-id=')) runIdOverride = a.split('=')[1] || null;
    }
    return { runIdOverride };
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

async function readPointerRunId(client, bucket) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: POINTER_KEY }));
    const buf = await streamToBuffer(res.Body);
    const ptr = JSON.parse(buf.toString());
    if (!ptr?.run_id) throw new Error(`Pointer ${POINTER_KEY} missing run_id`);
    return ptr.run_id;
}

async function openR2LineStream(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const nodeStream = res.Body instanceof Readable ? res.Body : Readable.from(res.Body);
    return readline.createInterface({ input: nodeStream, crlfDelay: Infinity });
}

function buildWorking() {
    const working = {};
    for (const [sourceId, entry] of Object.entries(SOURCE_REQUIRED_FIELDS)) {
        working[sourceId] = {
            file: entry.file,
            denominator_gate: entry.denominator_gate,
            required_paths: entry.required_paths,
            _stat: initStat(entry),
        };
    }
    return working;
}

function groupByFile(working) {
    const byFile = new Map();
    for (const [sourceId, entry] of Object.entries(working)) {
        if (!byFile.has(entry.file)) byFile.set(entry.file, []);
        byFile.get(entry.file).push([sourceId, entry]);
    }
    return byFile;
}

function printSummary(sources, totals, belowThreshold, severityTier, runId) {
    console.log(`\n[SOURCE-COMPLETENESS] === Summary ===`);
    console.log(`  Run id:                  ${runId}`);
    console.log(`  Total compounds:         ${totals.compounds}`);
    console.log(`  Total bioactivities:     ${totals.bioactivities}`);
    console.log(`  Total drug labels:       ${totals.drugLabels}`);
    console.log(`  DailyMed-linked %:       ${totals.dailymedLinkedPct}%`);
    console.log(`  --`);
    for (const [sourceId, s] of Object.entries(sources)) {
        // PR-CORE-1d: per-source threshold (override or global default)
        const tier = severityTierForPct(s.gate_adjusted_pct, sourceId);
        const flag = tier === 0 ? 'OK' : tier === 1 ? 'HARDFAIL' : tier === 2 ? 'WARN' : 'INFO';
        console.log(`  ${sourceId.padEnd(22)} raw=${String(s.raw_pct).padStart(6)}%  gate=${String(s.gate_adjusted_pct).padStart(6)}%  (${s.fully_enriched}/${s.gate_pass} of ${s.total}) [${flag}]`);
    }
    console.log(`  Below threshold (<95%):  ${belowThreshold.length === 0 ? 'none' : belowThreshold.join(', ')}`);
    console.log(`  Aggregate tier:          ${severityTier}`);
}

async function main() {
    const { runIdOverride } = parseArgs();
    console.log(`[SOURCE-COMPLETENESS] start; run-id override=${runIdOverride ?? '(latest)'}`);

    let client, bucket;
    try {
        client = makeR2Client();
        bucket = process.env.R2_BUCKET;
    } catch (err) {
        console.error(`[SOURCE-COMPLETENESS] R2 init failed: ${err.message}`);
        process.exit(4);
    }

    let runId;
    try {
        runId = runIdOverride ?? await readPointerRunId(client, bucket);
    } catch (err) {
        console.error(`[SOURCE-COMPLETENESS] Failed to resolve run_id: ${err.message}`);
        process.exit(4);
    }
    console.log(`[SOURCE-COMPLETENESS] scanning processed/aggregated/${runId}/`);

    const working = buildWorking();
    const byFile = groupByFile(working);

    const totals = { compounds: 0, bioactivities: 0, drugLabels: 0, dailymedLinkedPct: 0 };
    let dailymedLinkedCompounds = 0;

    for (const fname of filesNeeded()) {
        const key = `processed/aggregated/${runId}/${fname}`;
        const sources = byFile.get(fname) ?? [];
        try {
            const lineStream = await openR2LineStream(client, bucket, key);
            const { total, dailymedLinkedCompoundCount } = await scanFile(lineStream, sources);
            if (fname === 'compounds-enriched.jsonl') {
                totals.compounds = total;
                dailymedLinkedCompounds = dailymedLinkedCompoundCount;
            } else if (fname === 'bioactivities.jsonl') {
                totals.bioactivities = total;
            } else if (fname === 'drug-labels.jsonl') {
                totals.drugLabels = total;
            }
            console.log(`[SOURCE-COMPLETENESS] scanned ${fname}: ${total} records`);
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                console.error(`[SOURCE-COMPLETENESS] Missing required file in bundle: ${key}`);
                process.exit(4);
            }
            console.error(`[SOURCE-COMPLETENESS] Scan failure for ${key}: ${err.message}`);
            process.exit(4);
        }
    }

    const sources = {};
    for (const [sourceId, entry] of Object.entries(working)) {
        const s = entry._stat;
        s.raw_pct = pct(s.fully_enriched, s.total);
        s.gate_adjusted_pct = pct(s.fully_enriched, s.gate_pass);
        // PR-CORE-1d (2026-05-23): per-source severity_tier computed
        // against per-source threshold override (or global default for
        // sources without override). Lets downstream consumers read
        // per-source state without re-computing from raw pct.
        s.severity_tier = severityTierForPct(s.gate_adjusted_pct, sourceId);
        sources[sourceId] = s;
    }

    const severityTier = aggregateSeverity(sources);
    const belowThreshold = listBelowThreshold(sources);
    totals.dailymedLinkedPct = pct(dailymedLinkedCompounds, totals.compounds);

    const result = {
        audit_date: new Date().toISOString().slice(0, 10),
        run_id: runId,
        total_compounds: totals.compounds,
        total_bioactivities: totals.bioactivities,
        total_drug_labels: totals.drugLabels,
        sources,
        dailymed_linked_compounds_pct: totals.dailymedLinkedPct,
        severity_tier: severityTier,
        below_threshold: belowThreshold,
    };

    try {
        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: STATE_KEY,
            Body: JSON.stringify(result, null, 2),
            ContentType: 'application/json',
        }));
        console.log(`[SOURCE-COMPLETENESS] State emitted: ${STATE_KEY}`);
    } catch (err) {
        console.error(`[SOURCE-COMPLETENESS] State emit failed (non-fatal): ${err.message}`);
    }

    printSummary(sources, totals, belowThreshold, severityTier, runId);

    if (severityTier === 1) {
        console.error(`[SOURCE-COMPLETENESS] FAIL: at least one source < ${SEVERITY_THRESHOLDS.hardfail}% (HARDFAIL).`);
        process.exit(1);
    }
    if (severityTier === 2) {
        console.warn(`[SOURCE-COMPLETENESS] WARN: at least one source < ${SEVERITY_THRESHOLDS.warn}%.`);
        process.exit(2);
    }
    if (severityTier === 3) {
        console.log(`[SOURCE-COMPLETENESS] INFO: at least one source < ${SEVERITY_THRESHOLDS.info}%.`);
        process.exit(3);
    }
    console.log(`[SOURCE-COMPLETENESS] All 8 sources gate_adjusted_pct >= ${SEVERITY_THRESHOLDS.info}%. OK`);
    process.exit(0);
}

main().catch(err => {
    console.error('[SOURCE-COMPLETENESS] Fatal:', err);
    process.exit(4);
});
