/**
 * Snapshot Builder V0.4.3 — daily entity graph time-series snapshot.
 *
 * Continuous accumulation builds a retroactive dataset that cannot be
 * reconstructed from a later starting point. Every calendar day contributes
 * to citation / retraction / approval trajectory analysis.
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
import { SNAPSHOT_FILES } from './lib/aggregated-files.js';
import { LOINC_ATTRIBUTION } from './lib/umls-concept-streams.js';
import { streamSnapshotFile } from './lib/stream-snapshot-file.js';

// PR-T1.1-LEVER: neg-evidence whole-file is emitted via the streaming path (it
// stays additive + preserved after the FDA preserve-all uncap, so it can grow
// large). PR-COMPOUND-GUARD: compounds-search.jsonl is ALSO streamed (it is a
// per-compound projection that grows with the corpus). The streaming entry is
// byte-identical to the in-memory one.
const STREAMING_FILES = new Set(['neg-evidence.jsonl', 'compounds-search.jsonl']);

const SOURCE_DIR = './output/linked';
const SNAPSHOT_ROOT = './snapshots';

// V0.5.x: refuse to publish a snapshot without these files. Prevents the
// empty-snapshot regression where snapshot-uploader pushed a manifest with
// no data, overwriting the R2 latest pointer to point at nothing.
// PR-COMPOUND-GUARD (Step-5a): the two compound SERVING projections are
// REQUIRED -- the worker resolve/search paths depend on them, so latest.json
// must NOT advance over a missing projection (HARD-FAIL, exit 1). This applies
// in BOTH the streaming branch (compounds-search.jsonl) and the gzip branch
// (xref-index.json -> xref-index.json.gz).
const REQUIRED_FILES = ['compounds-enriched.jsonl', 'compounds-search.jsonl', 'xref-index.json'];

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
    // Date precedence: --date CLI arg > TARGET_DATE env (cycle 22 PR-L4
    // backfill) > today. Both allow snapshot-backfill.js to drive an OLD
    // target date without modifying builder logic.
    const dateStr = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
        || process.env.TARGET_DATE
        || todayUtcIso();
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
        const outPath = path.join(snapshotDir, `${fname}.gz`);
        let entry;

        if (STREAMING_FILES.has(fname)) {
            // Streaming path: never loads the whole file into memory. A REQUIRED
            // streaming file (PR-COMPOUND-GUARD: compounds-search.jsonl) that is
            // absent/empty HARD-FAILS (mirrors the gzip branch) so latest.json
            // never advances over a missing projection; non-required (neg-evidence)
            // keeps the skip-if-absent semantics.
            let st = null;
            try { st = await fs.stat(sourcePath); } catch { st = null; }
            if (!st || st.size === 0) {
                if (REQUIRED_FILES.includes(fname)) {
                    console.error(`[SNAPSHOT-BUILDER] Required file ${fname} missing or empty. Refusing to publish empty snapshot.`);
                    process.exit(1);
                }
                console.log(`  ${fname.padEnd(35)} (absent, skip)`);
                continue;
            }
            entry = await streamSnapshotFile(sourcePath, outPath, `${fname}.gz`);
        } else {
            const raw = await readIfExists(sourcePath);
            if (!raw || raw.length === 0) {
                if (REQUIRED_FILES.includes(fname)) {
                    console.error(`[SNAPSHOT-BUILDER] Required file ${fname} missing or empty. Refusing to publish empty snapshot.`);
                    process.exit(1);
                }
                console.log(`  ${fname.padEnd(35)} (absent, skip)`);
                continue;
            }
            const lines = raw.toString('utf-8').split('\n').filter(Boolean).length;
            const compressed = gzipSync(raw, { level: 9 });
            await fs.writeFile(outPath, compressed);
            entry = {
                filename: `${fname}.gz`,
                records: lines,
                uncompressed_bytes: raw.length,
                compressed_bytes: compressed.length,
                compression_ratio: +(compressed.length / raw.length).toFixed(3),
                sha256_uncompressed: sha256(raw),
                sha256_compressed: sha256(compressed),
            };
        }

        manifest.files.push(entry);
        manifest.total_uncompressed_bytes += entry.uncompressed_bytes;
        manifest.total_compressed_bytes += entry.compressed_bytes;
        manifest.total_records += entry.records;
        const savings = (100 - 100 * entry.compressed_bytes / entry.uncompressed_bytes).toFixed(0);
        console.log(`  ${fname.padEnd(35)} ${entry.records.toString().padStart(7)} records  ${(entry.uncompressed_bytes / 1024).toFixed(1).padStart(8)} KB -> ${(entry.compressed_bytes / 1024).toFixed(1).padStart(8)} KB (${savings}% savings)`);
    }

    // PR-UMLS-4: emit the verbatim Regenstrief LOINC attribution into a manifest
    // license_notices block when the LOINC public projection is present in this snapshot.
    // The LOINC license REQUIRES this notice on products that include LOINC codes; this
    // manifest block is one of the two real public-facing layers carrying it (the other is
    // the loinc-concepts-public.jsonl `#`-comment header). Additive + minimal: when LOINC is
    // absent (cold start) the block is simply not added.
    if (manifest.files.some(f => f.filename === 'loinc-concepts-public.jsonl.gz')) {
        manifest.license_notices = [
            { source: 'loinc', artifact: 'loinc-concepts-public.jsonl', notice: LOINC_ATTRIBUTION },
        ];
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
    console.log(`\n[SNAPSHOT-BUILDER] Snapshot complete: TICK (this is snapshot ${dateStr})`);
}

main().catch(err => { console.error('[SNAPSHOT-BUILDER] Fatal:', err); process.exit(1); });
