/**
 * Snapshot Builder V0.4.3 — daily entity graph snapshot for Layer 4 time-series.
 *
 * Per 2026-05-13 strategic plan: Layer 4 (time dimension) is the only
 * physically non-copyable moat. A competitor starting today cannot
 * retroactively get last year's daily snapshots. Every day Sciweon
 * misses, the catch-up window stays open one more day.
 *
 * This step packages the output/linked/*.jsonl files into a date-stamped
 * R2 prefix with manifest (record counts + SHA-256 checksums). Upload
 * to R2 is a separate step (snapshot-uploader.js) that runs when R2
 * credentials are configured.
 *
 * Snapshot layout:
 *   snapshots/YYYY-MM-DD/
 *     compounds-enriched.jsonl.zst
 *     bioactivities.jsonl.zst
 *     trials.jsonl.zst
 *     papers.jsonl.zst
 *     neg-evidence.jsonl.zst
 *     manifest.json
 *
 * V0.4.3 minimum-viable scope: build the snapshot locally + manifest.
 * R2 upload + GHA cron is the deployment side (uncomment when credentials
 * are configured in repo secrets).
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';

const SOURCE_DIR = './output/linked';
const SNAPSHOT_ROOT = './snapshots';

const SNAPSHOT_FILES = [
    'compounds-enriched.jsonl',
    'bioactivities.jsonl',
    'trials.jsonl',
    'trial-links.jsonl',
    'papers.jsonl',
    'paper-links.jsonl',
    'negative-evidence-raw.jsonl',
    'neg-evidence.jsonl',
];

function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

async function readIfExists(file) {
    try { return await fs.readFile(file); }
    catch { return null; }
}

function todayUtcIso() {
    return new Date().toISOString().slice(0, 10);
}

async function main() {
    const dateStr = process.argv.find(a => a.startsWith('--date='))?.split('=')[1] || todayUtcIso();
    console.log(`[SNAPSHOT-BUILDER] V0.4.3 — building snapshot ${dateStr}`);

    const snapshotDir = path.join(SNAPSHOT_ROOT, dateStr);
    await fs.mkdir(snapshotDir, { recursive: true });

    const manifest = {
        snapshot_date: dateStr,
        created_at: new Date().toISOString(),
        sciweon_version: 'V0.4.3',
        files: [],
        total_uncompressed_bytes: 0,
        total_compressed_bytes: 0,
        total_records: 0,
    };

    for (const fname of SNAPSHOT_FILES) {
        const sourcePath = path.join(SOURCE_DIR, fname);
        const raw = await readIfExists(sourcePath);
        if (!raw) {
            console.log(`  ${fname.padEnd(35)} (absent, skip)`);
            continue;
        }
        const lines = raw.toString('utf-8').split('\n').filter(Boolean).length;
        const compressed = gzipSync(raw, { level: 9 });
        const outPath = path.join(snapshotDir, `${fname}.gz`);
        await fs.writeFile(outPath, compressed);

        const entry = {
            filename: `${fname}.gz`,
            records: lines,
            uncompressed_bytes: raw.length,
            compressed_bytes: compressed.length,
            compression_ratio: +(compressed.length / raw.length).toFixed(3),
            sha256_uncompressed: sha256(raw),
            sha256_compressed: sha256(compressed),
        };
        manifest.files.push(entry);
        manifest.total_uncompressed_bytes += raw.length;
        manifest.total_compressed_bytes += compressed.length;
        manifest.total_records += lines;
        console.log(`  ${fname.padEnd(35)} ${lines.toString().padStart(7)} records  ${(raw.length / 1024).toFixed(1).padStart(8)} KB -> ${(compressed.length / 1024).toFixed(1).padStart(8)} KB (${(100 - 100 * compressed.length / raw.length).toFixed(0)}% savings)`);
    }

    const manifestPath = path.join(snapshotDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    console.log(`\n[SNAPSHOT-BUILDER] Complete`);
    console.log(`  Snapshot:           ${snapshotDir}`);
    console.log(`  Files:              ${manifest.files.length}`);
    console.log(`  Total records:      ${manifest.total_records.toLocaleString()}`);
    console.log(`  Uncompressed:       ${(manifest.total_uncompressed_bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Compressed:         ${(manifest.total_compressed_bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Manifest:           ${manifestPath}`);
    console.log(`\n[SNAPSHOT-BUILDER] Layer 4 clock: TICK (this is snapshot ${dateStr})`);
}

main().catch(err => { console.error('[SNAPSHOT-BUILDER] Fatal:', err); process.exit(1); });
