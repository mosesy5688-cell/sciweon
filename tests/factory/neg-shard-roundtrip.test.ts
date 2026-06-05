// @ts-nocheck
/**
 * REQUIRED CI GATE — neg-shard byte-roundtrip.
 *
 * De-risks the ONLY previously-unproven link in the crux: write a neg PAGE
 * entity via ShardWriter (zstd, the same primitive the publisher uses) ->
 * read it back by (offset, size) from the shard file (simulating the worker's
 * R2 range-read) -> decompressPayload (the worker's fzstd decode) -> assert the
 * decoded text is BYTE-IDENTICAL to the original page text.
 *
 * If this passes, the producer's ShardWriter.writeEntity zstd frames are
 * decodable by the worker's fzstd, and the (offset,size) bookkeeping in the
 * manifest correctly addresses the entity bytes inside the shard.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ShardWriter } from '../../scripts/factory/lib/shard-writer.js';
import { decompressPayload } from '../../src/worker/lib/shard-codec';

async function tmpDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'neg-roundtrip-'));
}

// A realistic neg page: several raw jsonl records joined by newline (exactly
// what neg-shard-publisher serializes as one ShardWriter entity).
function makePageText(n: number): string {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
        lines.push(JSON.stringify({
            id: `sciweon::neg::trial::NCT${String(1000000 + i)}`,
            evidence_type: 'trial_failure',
            subject: { compound_id: 'sciweon::compound::CID:2244', trial_id: `sciweon::trial::NCT${1000000 + i}` },
            severity: i % 2 === 0 ? 'critical' : 'minor',
            failure: { reason_category: 'SAFETY' },
        }));
    }
    return lines.join('\n');
}

describe('neg-shard byte-roundtrip — write -> range-read -> decode', () => {
    it('single page entity round-trips byte-identical', async () => {
        const dir = await tmpDir();
        const writer = new ShardWriter(dir, 'shard');
        await writer.init();
        writer.open();

        const pageText = makePageText(64);
        const payload = Buffer.from(pageText, 'utf-8');
        const { offset, size } = writer.writeEntity(payload);
        writer.finalize();

        // Simulate the worker R2 range-read: read exactly [offset, offset+size).
        const fd = await fs.open(path.join(dir, 'shard-000.bin'), 'r');
        const buf = Buffer.alloc(size);
        await fd.read(buf, 0, size, offset);
        await fd.close();

        const decoded = decompressPayload(new Uint8Array(buf));
        expect(decoded).toBe(pageText);

        await fs.rm(dir, { recursive: true });
    });

    it('multiple page entities each round-trip at their own (offset,size)', async () => {
        const dir = await tmpDir();
        const writer = new ShardWriter(dir, 'shard');
        await writer.init();
        writer.open();

        const pages = [makePageText(64), makePageText(10), makePageText(1)];
        const refs: Array<{ offset: number; size: number; text: string }> = [];
        for (const text of pages) {
            const { offset, size } = writer.writeEntity(Buffer.from(text, 'utf-8'));
            refs.push({ offset, size, text });
        }
        writer.finalize();

        const fd = await fs.open(path.join(dir, 'shard-000.bin'), 'r');
        for (const ref of refs) {
            const buf = Buffer.alloc(ref.size);
            await fd.read(buf, 0, ref.size, ref.offset);
            const decoded = decompressPayload(new Uint8Array(buf), true); // strict mode
            expect(decoded).toBe(ref.text);
        }
        await fd.close();
        await fs.rm(dir, { recursive: true });
    });

    it('strict decompress HARD-FAILS on garbage bytes (no plaintext fallback)', () => {
        const garbage = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
        expect(() => decompressPayload(garbage, true)).toThrow(/strict/i);
        // lenient mode returns the bytes as text instead of throwing
        expect(decompressPayload(garbage, false)).toBeTypeOf('string');
    });
});
