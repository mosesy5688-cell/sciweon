/**
 * Source Completeness V1 (cycle 22 PR-CORE-1) — Pattern E tracker.
 *
 * Per-source × tier-class completeness audit. Scans the latest aggregated
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
 * of the 5 banned 取巧 patterns under [[no_shortcut_in_science]].
 *
 * Usage:
 *   node source-completeness.js [--run-id=<id>]
 *
 * --run-id is optional. Default = latest aggregated run via the standard
 * pointer at processed/aggregated/latest.json.
 *
 * Exit codes:
 *   0  all 8 sources gate_adjusted_pct >= 95 (healthy)
 *   1  HARDFAIL — any source gate_adjusted_pct < 50 (catastrophic drop)
 *   2  WARN — any source gate_adjusted_pct < 80 (PR-CORE-2 priority signal)
 *   3  INFO — any source gate_adjusted_pct < 95 (low-priority gap)
 *   4  R2 access failure
 *
 * Output:
 *   R2 state/source-completeness.json — per-source stats. Consumed by
 *   PR-CORE-2 prioritization and dashboards. Schema documented in plan
 *   and in the persisted JSON itself (sources object keyed by source id).
 */

import readline from 'readline';
import { Readable } from 'stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SOURCE_REQUIRED_FIELDS, SEVERITY_THRESHOLDS, filesNeeded } from './lib/source-required-fields.js';

const STATE_KEY = 'state/source-completeness.json';
const POINTER_KEY = 'processed/aggregated/latest.json';

function parseArgs() {
    const args = process.argv.slice(2);
    let runIdOverride = null;
    for (const a of args) {
        if (a.startsWith('--run-id=')) {
            runIdOverride = a.split('=')[1] || null;
        }
    }
    return { runIdOverride };
}

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length > 0) {
        throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    }
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

// Walk a dotted path on a record, returning undefined if any segment is
// absent. Does not throw — caller decides whether undefined fails the
// required check.
export function getPath(record, dottedPath) {
    if (record == null) return undefined;
    const segs = dottedPath.split('.');
    let cur = record;
    for (const seg of segs) {
        if (cur == null) return undefined;
        cur = cur[seg];
    }
    return cur;
}

// Evaluate one required_paths entry against a record. Supports plain
// dotted path (non-null check), [] suffix (array length>=1), ===literal
// suffix (strict equality), and ~~literal suffix (array.includes).
// Returns boolean. The encoding lives here, not in callers, so the
// tracker can iterate registry entries uniformly.
export function checkRequiredPath(record, encoded) {
    // === literal equality
    const eqIdx = encoded.indexOf('===');
    if (eqIdx !== -1) {
        const path = encoded.slice(0, eqIdx);
        const literal = JSON.parse(encoded.slice(eqIdx + 3));
        return getPath(record, path) === literal;
    }
    // ~~ array contains literal
    const inIdx = encoded.indexOf('~~');
    if (inIdx !== -1) {
        const path = encoded.slice(0, inIdx);
        const literal = JSON.parse(encoded.slice(inIdx + 2));
        const v = getPath(record, path);
        return Array.isArray(v) && v.includes(literal);
    }
    // [] array non-empty
    if (encoded.endsWith('[]')) {
        const path = encoded.slice(0, -2);
        const v = getPath(record, path);
        return Array.isArray(v) && v.length >= 1;
    }
    // plain non-null
    const v = getPath(record, encoded);
    return v != null;
}

// Evaluate gate predicate (a dotted path that must resolve to non-null)
// or `null` (no gate — always passes).
export function checkGate(record, gate) {
    if (gate == null) return true;
    return getPath(record, gate) != null;
}

// True iff every required path passes for this source on this record.
export function isFullyEnriched(record, sourceEntry) {
    for (const p of sourceEntry.required_paths) {
        if (!checkRequiredPath(record, p)) return false;
    }
    return true;
}

// Map a 0-100 percentage to a severity tier (0=healthy, 1=hardfail,
// 2=warn, 3=info). NaN / missing data treated as worst-case hardfail.
export function severityTierForPct(pct) {
    if (!Number.isFinite(pct)) return 1;
    if (pct < SEVERITY_THRESHOLDS.hardfail) return 1;
    if (pct < SEVERITY_THRESHOLDS.warn) return 2;
    if (pct < SEVERITY_THRESHOLDS.info) return 3;
    return 0;
}

// Aggregate per-source tiers into a single worst-case exit-code tier.
// Severity ordering (worst → best): 1 (hardfail) > 2 (warn) > 3 (info) > 0 (healthy).
// Returns the most-severe (lowest non-zero) tier present across all sources.
export function aggregateSeverity(perSourceStats) {
    let anyHardfail = false, anyWarn = false, anyInfo = false;
    for (const stat of Object.values(perSourceStats)) {
        const t = severityTierForPct(stat.gate_adjusted_pct);
        if (t === 1) anyHardfail = true;
        else if (t === 2) anyWarn = true;
        else if (t === 3) anyInfo = true;
    }
    if (anyHardfail) return 1;
    if (anyWarn) return 2;
    if (anyInfo) return 3;
    return 0;
}

export function listBelowThreshold(perSourceStats, threshold = SEVERITY_THRESHOLDS.info) {
    const out = [];
    for (const [source, stat] of Object.entries(perSourceStats)) {
        if (!(stat.gate_adjusted_pct >= threshold)) out.push(source);
    }
    return out;
}

// Round to 2 decimal places, NaN-safe.
function pct(numer, denom) {
    if (denom <= 0) return 100;
    return +(100 * numer / denom).toFixed(2);
}

// Initialize a per-source counter object.
function initStat(sourceEntry) {
    return {
        file: sourceEntry.file,
        total: 0,
        gate_pass: 0,
        fully_enriched: 0,
        raw_pct: 0,
        gate_adjusted_pct: 0,
    };
}

// One streaming pass over a file, updating all source counters whose
// `file` matches. Returns total record count for the file.
export async function scanFile(lineStream, sourcesForThisFile) {
    let total = 0;
    let dailymedLinkedCompoundCount = 0;
    const dailymedTrackForCompounds = sourcesForThisFile.some(
        ([, e]) => e.file === 'compounds-enriched.jsonl',
    );
    for await (const line of lineStream) {
        if (!line) continue;
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            // Malformed line — refuse to silently swallow
            // ([[cross_cycle_silent_data_loss]]). Drug-labels.jsonl from
            // PR #103 may be empty (zero lines) but never partially-valid.
            throw new Error(`Malformed JSONL line encountered (skipping not permitted): ${line.slice(0, 120)}...`);
        }
        total++;
        for (const [, entry] of sourcesForThisFile) {
            const gatePass = checkGate(rec, entry.denominator_gate);
            entry._stat.total++;
            if (gatePass) {
                entry._stat.gate_pass++;
                if (isFullyEnriched(rec, entry)) {
                    entry._stat.fully_enriched++;
                }
            }
        }
        // DailyMed dual-surface: count compounds with non-empty drug_labels[]
        if (dailymedTrackForCompounds && Array.isArray(rec.drug_labels) && rec.drug_labels.length > 0) {
            dailymedLinkedCompoundCount++;
        }
    }
    return { total, dailymedLinkedCompoundCount };
}

async function readPointerRunId(client, bucket) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: POINTER_KEY }));
    const buf = await streamToBuffer(res.Body);
    const ptr = JSON.parse(buf.toString());
    if (!ptr?.run_id) throw new Error(`Pointer ${POINTER_KEY} missing run_id`);
    return ptr.run_id;
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function openR2LineStream(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const nodeStream = res.Body instanceof Readable ? res.Body : Readable.from(res.Body);
    return readline.createInterface({ input: nodeStream, crlfDelay: Infinity });
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

    // Initialize per-source stats by attaching mutable _stat to a working
    // shallow copy. SOURCE_REQUIRED_FIELDS itself stays frozen.
    const working = {};
    for (const [sourceId, entry] of Object.entries(SOURCE_REQUIRED_FIELDS)) {
        working[sourceId] = {
            file: entry.file,
            denominator_gate: entry.denominator_gate,
            required_paths: entry.required_paths,
            _stat: initStat(entry),
        };
    }

    // Group sources by their target file for one streaming pass per file.
    const byFile = new Map();
    for (const [sourceId, entry] of Object.entries(working)) {
        if (!byFile.has(entry.file)) byFile.set(entry.file, []);
        byFile.get(entry.file).push([sourceId, entry]);
    }

    let totalCompounds = 0;
    let totalBioactivities = 0;
    let totalDrugLabels = 0;
    let dailymedLinkedCompounds = 0;

    for (const fname of filesNeeded()) {
        const key = `processed/aggregated/${runId}/${fname}`;
        const sources = byFile.get(fname) ?? [];
        try {
            const lineStream = await openR2LineStream(client, bucket, key);
            const { total, dailymedLinkedCompoundCount } = await scanFile(lineStream, sources);
            if (fname === 'compounds-enriched.jsonl') {
                totalCompounds = total;
                dailymedLinkedCompounds = dailymedLinkedCompoundCount;
            } else if (fname === 'bioactivities.jsonl') {
                totalBioactivities = total;
            } else if (fname === 'drug-labels.jsonl') {
                totalDrugLabels = total;
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

    // Finalize per-source pcts.
    const sources = {};
    for (const [sourceId, entry] of Object.entries(working)) {
        const s = entry._stat;
        s.raw_pct = pct(s.fully_enriched, s.total);
        s.gate_adjusted_pct = pct(s.fully_enriched, s.gate_pass);
        sources[sourceId] = s;
    }

    const severityTier = aggregateSeverity(sources);
    const belowThreshold = listBelowThreshold(sources);

    const result = {
        audit_date: new Date().toISOString().slice(0, 10),
        run_id: runId,
        total_compounds: totalCompounds,
        total_bioactivities: totalBioactivities,
        total_drug_labels: totalDrugLabels,
        sources,
        dailymed_linked_compounds_pct: pct(dailymedLinkedCompounds, totalCompounds),
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

    // Console summary
    console.log(`\n[SOURCE-COMPLETENESS] === Summary ===`);
    console.log(`  Run id:                  ${runId}`);
    console.log(`  Total compounds:         ${totalCompounds}`);
    console.log(`  Total bioactivities:     ${totalBioactivities}`);
    console.log(`  Total drug labels:       ${totalDrugLabels}`);
    console.log(`  DailyMed-linked %:       ${result.dailymed_linked_compounds_pct}%`);
    console.log(`  --`);
    for (const [sourceId, s] of Object.entries(sources)) {
        const tier = severityTierForPct(s.gate_adjusted_pct);
        const flag = tier === 0 ? '✅' : tier === 1 ? '🔴 HARDFAIL' : tier === 2 ? '🟠 WARN' : '🟡 INFO';
        console.log(`  ${sourceId.padEnd(22)} raw=${String(s.raw_pct).padStart(6)}%  gate=${String(s.gate_adjusted_pct).padStart(6)}%  (${s.fully_enriched}/${s.gate_pass} of ${s.total}) ${flag}`);
    }
    console.log(`  Below threshold (<95%):  ${belowThreshold.length === 0 ? 'none' : belowThreshold.join(', ')}`);
    console.log(`  Aggregate tier:          ${severityTier}`);

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
    console.log(`[SOURCE-COMPLETENESS] All 8 sources gate_adjusted_pct >= ${SEVERITY_THRESHOLDS.info}%. ✅`);
    process.exit(0);
}

// Allow direct import for tests without auto-running main().
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => {
        console.error('[SOURCE-COMPLETENESS] Fatal:', err);
        process.exit(4);
    });
}
