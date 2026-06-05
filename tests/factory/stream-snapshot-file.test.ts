// @ts-nocheck
/**
 * stream-snapshot-file: the streaming neg-evidence emitter MUST produce a
 * manifest entry byte-identical to the in-memory gzipSync path, and write a
 * byte-identical .gz file. snapshot-downloader.js + snapshot-history-gate.js
 * consume {records, sha256_uncompressed, sha256_compressed, ...} — dropping or
 * drifting any of these would break downstream consumers.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { streamSnapshotFile } from '../../scripts/factory/lib/stream-snapshot-file.js';

function sha256(b: Buffer): string {
    return createHash('sha256').update(b).digest('hex');
}

function inMemoryEntry(content: string, filename: string) {
    const raw = Buffer.from(content, 'utf-8');
    const lines = raw.toString('utf-8').split('\n').filter(Boolean).length;
    const compressed = gzipSync(raw, { level: 9 });
    return {
        entry: {
            filename,
            records: lines,
            uncompressed_bytes: raw.length,
            compressed_bytes: compressed.length,
            compression_ratio: +(compressed.length / raw.length).toFixed(3),
            sha256_uncompressed: sha256(raw),
            sha256_compressed: sha256(compressed),
        },
        compressed,
    };
}

async function roundtrip(content: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapb-'));
    const src = path.join(dir, 'neg-evidence.jsonl');
    const out = path.join(dir, 'neg-evidence.jsonl.gz');
    await fs.writeFile(src, content);
    const got = await streamSnapshotFile(src, out, 'neg-evidence.jsonl.gz');
    const writtenGz = await fs.readFile(out);
    await fs.rm(dir, { recursive: true });
    return { got, writtenGz };
}

describe('streamSnapshotFile — byte-identical to in-memory gzipSync', () => {
    it('multi-line content with empty lines + trailing line', async () => {
        const content = ['{"id":"a"}', '{"id":"b"}', '', '{"id":"c"}'].join('\n');
        const { entry, compressed } = inMemoryEntry(content, 'neg-evidence.jsonl.gz');
        const { got, writtenGz } = await roundtrip(content);
        expect(got).toEqual(entry);
        expect(writtenGz.equals(compressed)).toBe(true);
    });

    it('content WITH a trailing newline', async () => {
        const content = ['{"id":"a"}', '{"id":"b"}', ''].join('\n'); // trailing newline
        const { entry } = inMemoryEntry(content, 'neg-evidence.jsonl.gz');
        const { got } = await roundtrip(content);
        expect(got).toEqual(entry);
    });

    it('larger content (multi-chunk) stays byte-identical', async () => {
        const lines: string[] = [];
        for (let i = 0; i < 20000; i++) lines.push(JSON.stringify({ id: `r${i}`, severity: 'critical' }));
        const content = lines.join('\n');
        const { entry, compressed } = inMemoryEntry(content, 'neg-evidence.jsonl.gz');
        const { got, writtenGz } = await roundtrip(content);
        expect(got.records).toBe(20000);
        expect(got).toEqual(entry);
        expect(writtenGz.equals(compressed)).toBe(true);
    });
});
