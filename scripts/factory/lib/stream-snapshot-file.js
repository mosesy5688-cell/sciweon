/**
 * stream-snapshot-file — streaming, sha256-preserving snapshot file emitter.
 *
 * PR-T1.1-LEVER: the neg-evidence whole-file is preserved (additive bulk) even
 * after the FDA preserve-all uncap, so it can grow large. This emits it WITHOUT
 * loading the whole file into memory: createReadStream -> incremental sha256 of
 * the uncompressed bytes + record count -> createGzip(level:9) -> incremental
 * sha256 of the compressed bytes -> write to disk.
 *
 * Node's createGzip(level:9) is BYTE-IDENTICAL to gzipSync(buf,{level:9}) for
 * the same input (verified), so the manifest entry it produces
 * ({filename, records, uncompressed_bytes, compressed_bytes, compression_ratio,
 * sha256_uncompressed, sha256_compressed}) is byte-identical to the in-memory
 * path's entry. snapshot-downloader.js + snapshot-history-gate.js consume these
 * fields unchanged.
 */

import { createReadStream, createWriteStream } from 'fs';
import { createGzip } from 'zlib';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

/**
 * Build a manifest entry for `sourcePath`, streaming through gzip into
 * `outPath`. Counts newline-delimited non-empty records the same way the
 * in-memory path does (split('\n').filter(Boolean).length) — implemented as a
 * running scan over chunks so it never materializes the whole file.
 *
 * Returns { filename, records, uncompressed_bytes, compressed_bytes,
 *           compression_ratio, sha256_uncompressed, sha256_compressed }.
 */
export async function streamSnapshotFile(sourcePath, outPath, filename) {
    const shaUncompressed = createHash('sha256');
    const shaCompressed = createHash('sha256');
    let uncompressedBytes = 0;
    let compressedBytes = 0;
    let records = 0;
    let trailing = ''; // partial line carried across chunk boundaries

    // Tap the uncompressed stream: hash + byte count + record count.
    const tap = new Transform({
        transform(chunk, _enc, cb) {
            shaUncompressed.update(chunk);
            uncompressedBytes += chunk.length;
            // record count = number of non-empty lines (matches
            // raw.toString().split('\n').filter(Boolean).length)
            const text = trailing + chunk.toString('utf-8');
            const parts = text.split('\n');
            trailing = parts.pop(); // last fragment may be incomplete
            for (const p of parts) if (p.length > 0) records++;
            cb(null, chunk);
        },
        flush(cb) {
            if (trailing.length > 0) records++;
            cb();
        },
    });

    const gzip = createGzip({ level: 9 });
    // Tap the compressed stream: hash + byte count.
    const tapCompressed = new Transform({
        transform(chunk, _enc, cb) {
            shaCompressed.update(chunk);
            compressedBytes += chunk.length;
            cb(null, chunk);
        },
    });

    await pipeline(
        createReadStream(sourcePath),
        tap,
        gzip,
        tapCompressed,
        createWriteStream(outPath),
    );

    return {
        filename,
        records,
        uncompressed_bytes: uncompressedBytes,
        compressed_bytes: compressedBytes,
        compression_ratio: +(compressedBytes / uncompressedBytes).toFixed(3),
        sha256_uncompressed: shaUncompressed.digest('hex'),
        sha256_compressed: shaCompressed.digest('hex'),
    };
}
