/**
 * Snapshot Audit V0.7 (cycle 22 PR-L4) — Layer 4 daily completeness scanner.
 *
 * Scans R2 snapshots/<YYYY-MM-DD>/ presence across a configurable window
 * (default 60 days), computes completeness %, emits state JSON, exits with
 * code indicating severity of any gaps.
 *
 * Cycle 22 motivation: 2026-05-22 audit observed 22% miss rate (5/14 + 5/19
 * missing among last 9 days). No detection mechanism existed pre-this-PR;
 * gaps surfaced only via mid-session user investigation. Layer 4 time-
 * dimension moat (per `[[reference_verified_facts]]` triple-lock §规模)
 * requires explicit measurement + HARDFAIL on recent gaps.
 *
 * Usage:
 *   node snapshot-audit.js [--window=60]
 *
 * Exit codes:
 *   0  last 7 days complete (healthy)
 *   1  missing in last 7 days (HARDFAIL — blocks reliance)
 *   2  last 7d complete, missing in 8-30d window (warn — backfillable)
 *   3  last 30d complete, missing 31-N window (info — low-priority backfill)
 *   4  R2 access failure
 *
 * Output:
 *   R2 state/snapshot-completeness.json — per-window stats consumed by
 *   Pattern E completeness tracker (PR-CORE-1) as Layer 4 sibling metric.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
    makeR2Client, listSnapshotDates, expectedDateRange, computeCompleteness,
} from './lib/snapshot-bridge.js';

const STATE_KEY = 'state/snapshot-completeness.json';

function parseArgs() {
    const args = process.argv.slice(2);
    const window = parseInt(
        args.find(a => a.startsWith('--window='))?.split('=')[1] ?? '60',
        10,
    );
    if (!Number.isFinite(window) || window < 1 || window > 365) {
        throw new Error(`--window must be 1-365, got ${window}`);
    }
    return { window };
}

function categorizeWindow(missing) {
    const today = new Date().toISOString().slice(0, 10);
    const t = Date.parse(today);
    const ageDays = d => Math.floor((t - Date.parse(d)) / 86400000);
    const last7 = missing.filter(d => ageDays(d) <= 7);
    const between8_30 = missing.filter(d => ageDays(d) > 7 && ageDays(d) <= 30);
    const beyond30 = missing.filter(d => ageDays(d) > 30);
    return { last7, between8_30, beyond30 };
}

async function main() {
    const { window } = parseArgs();
    console.log(`[SNAPSHOT-AUDIT] window=${window}d, scanning R2 snapshots/<date>/`);

    let client, bucket;
    try {
        client = makeR2Client();
        bucket = process.env.R2_BUCKET;
    } catch (err) {
        console.error(`[SNAPSHOT-AUDIT] R2 init failed: ${err.message}`);
        process.exit(4);
    }

    const presentDates = await listSnapshotDates(client, bucket);
    const today = new Date().toISOString().slice(0, 10);
    const expectedDates = expectedDateRange(window, today);
    const { present, missing, present_pct } = computeCompleteness(expectedDates, presentDates);
    const cat = categorizeWindow(missing);

    const result = {
        audit_date: today,
        window_days: window,
        expected_count: expectedDates.length,
        present_count: present.length,
        missing_count: missing.length,
        present_pct,
        missing_dates: missing,
        missing_by_age: {
            last_7d: cat.last7,
            between_8_30d: cat.between8_30,
            beyond_30d: cat.beyond30,
        },
        last_7d_complete: cat.last7.length === 0,
        last_30d_complete_pct: (() => {
            const exp = expectedDateRange(Math.min(30, window), today);
            const presSet = new Set(presentDates);
            const pres = exp.filter(d => presSet.has(d));
            return exp.length === 0 ? 100 : +(100 * pres.length / exp.length).toFixed(2);
        })(),
    };

    // Persist state JSON to R2 (consumed by Pattern E + dashboards)
    try {
        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: STATE_KEY,
            Body: JSON.stringify(result, null, 2),
            ContentType: 'application/json',
        }));
        console.log(`[SNAPSHOT-AUDIT] State emitted: ${STATE_KEY}`);
    } catch (err) {
        console.error(`[SNAPSHOT-AUDIT] State emit failed (non-fatal): ${err.message}`);
    }

    // Console summary
    console.log(`\n[SNAPSHOT-AUDIT] === Summary ===`);
    console.log(`  Window:              ${window} days`);
    console.log(`  Expected dates:      ${expectedDates.length}`);
    console.log(`  Present in R2:       ${present.length}`);
    console.log(`  Missing total:       ${missing.length} (present_pct=${present_pct}%)`);
    console.log(`  Missing last 7d:     ${cat.last7.length} ${cat.last7.length > 0 ? '⚠️  HARDFAIL trigger' : '✅'}`);
    console.log(`  Missing 8-30d:       ${cat.between8_30.length} ${cat.between8_30.length > 0 ? '⚠️  backfillable warn' : '✅'}`);
    console.log(`  Missing beyond 30d:  ${cat.beyond30.length} ${cat.beyond30.length > 0 ? '(info)' : '✅'}`);
    if (missing.length > 0) {
        console.log(`  Missing dates:       ${missing.join(', ')}`);
    }

    // Exit code per severity tier
    if (cat.last7.length > 0) {
        console.error(`[SNAPSHOT-AUDIT] FAIL: ${cat.last7.length} missing in last 7d (HARDFAIL).`);
        process.exit(1);
    }
    if (cat.between8_30.length > 0) {
        console.warn(`[SNAPSHOT-AUDIT] WARN: ${cat.between8_30.length} missing in 8-30d window. Run backfill via factory-snapshot-audit.yml dispatch.`);
        process.exit(2);
    }
    if (cat.beyond30.length > 0) {
        console.log(`[SNAPSHOT-AUDIT] INFO: ${cat.beyond30.length} missing beyond 30d (low-priority backfill).`);
        process.exit(3);
    }
    console.log(`[SNAPSHOT-AUDIT] All ${expectedDates.length} dates in window present. ✅`);
    process.exit(0);
}

main().catch(err => {
    console.error('[SNAPSHOT-AUDIT] Fatal:', err);
    process.exit(4);
});
