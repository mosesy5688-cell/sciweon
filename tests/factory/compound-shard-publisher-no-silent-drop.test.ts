// @ts-nocheck
/**
 * FIX M5 ([[cross_cycle_silent_data_loss]]) — compound-shard-publisher counter+throw.
 *
 * readCompoundsInOrder previously silently dropped records: malformed JSON
 * (`catch { continue; }`) and a non-numeric pubchem_cid (`typeof cid !== 'number'`)
 * — ZERO telemetry. The snapshot manifest + historical gate count the whole
 * pre-skip jsonl, so they CANNOT detect a shard-side skip; compound-loader then
 * returns an authoritative null (404) for a dropped CID -> /compound/:id 404s
 * all snapshot day, INVISIBLE. A String-serialized pubchem_cid is the live
 * trigger. Mirrors the proven neg-shard-publisher#publishNegShards template
 * (count + refuse-to-publish + LOUD throw).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { readCompoundsInOrder } from '../../scripts/factory/lib/compound-shard-publisher.js';

async function makeTmpJsonl(lines: string[]): Promise<{ file: string; dir: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compound-shard-drop-'));
    const file = path.join(dir, 'compounds-enriched.jsonl');
    await fs.writeFile(file, lines.join('\n'));
    return { file, dir };
}

describe('compound-shard-publisher readCompoundsInOrder — NO SILENT DROP', () => {
    it('THROWS on a non-numeric (String-serialized) pubchem_cid', async () => {
        const { file, dir } = await makeTmpJsonl([
            JSON.stringify({ pubchem_cid: 2244, inchi_key: 'A' }),
            JSON.stringify({ pubchem_cid: '4091', inchi_key: 'B' }), // String CID -> would 404 silently
            JSON.stringify({ pubchem_cid: 3672, inchi_key: 'C' }),
        ]);
        await expect(readCompoundsInOrder(file)).rejects.toThrow(/nonNumericCid=1/);
        await expect(readCompoundsInOrder(file)).rejects.toThrow(/refusing to publish/);
        await fs.rm(dir, { recursive: true });
    });

    it('THROWS on a malformed JSON line', async () => {
        const { file, dir } = await makeTmpJsonl([
            JSON.stringify({ pubchem_cid: 2244 }),
            '{ this is not json',
        ]);
        await expect(readCompoundsInOrder(file)).rejects.toThrow(/malformed=1/);
        await fs.rm(dir, { recursive: true });
    });

    it('an all-numeric-cid fixture publishes fine (no throw, CID-asc sorted)', async () => {
        const { file, dir } = await makeTmpJsonl([
            JSON.stringify({ pubchem_cid: 3672, inchi_key: 'C' }),
            JSON.stringify({ pubchem_cid: 2244, inchi_key: 'A' }),
        ]);
        const records = await readCompoundsInOrder(file);
        expect(records.length).toBe(2);
        expect(records.map(r => r.cid)).toEqual([2244, 3672]); // CID-asc stable sort preserved
        await fs.rm(dir, { recursive: true });
    });
});
