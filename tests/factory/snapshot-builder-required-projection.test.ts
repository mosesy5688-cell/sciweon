// @ts-nocheck
/**
 * PR-COMPOUND-GUARD (Step-5a) — snapshot-builder REQUIRED-files guard.
 *
 * The two compound serving projections (compounds-search.jsonl, xref-index.json)
 * are in REQUIRED_FILES, so snapshot-builder HARD-FAILS (exit 1) if either is
 * absent -> latest.json never advances over a missing projection. compounds-
 * search.jsonl is in the STREAMING branch; xref-index.json in the gzip branch:
 * the guard must fire in BOTH branches.
 *
 * Driven by spawning the real script with cwd = a temp dir (SOURCE_DIR is
 * ./output/linked relative to cwd; the ESM lib imports resolve from the script
 * file location, so the real aggregated-files SSoT is exercised).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const SCRIPT = path.resolve(__dirname, '../../scripts/factory/snapshot-builder.js');
let cwd: string;
let linked: string;

async function writeLinked(fname: string, body: string) {
    await fs.writeFile(path.join(linked, fname), body, 'utf-8');
}

function runBuilder() {
    return spawnSync('node', [SCRIPT, '--date=2026-06-06'], { cwd, encoding: 'utf-8' });
}

beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-builder-'));
    linked = path.join(cwd, 'output', 'linked');
    await fs.mkdir(linked, { recursive: true });
    // a non-empty compounds-enriched so the FIRST required file passes.
    await writeLinked('compounds-enriched.jsonl', JSON.stringify({ pubchem_cid: 2244, id: 'x' }) + '\n');
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

describe('snapshot-builder REQUIRED projection guard', () => {
    it('exit 1 when compounds-search.jsonl (streaming-branch required) is absent', async () => {
        // xref-index present so we isolate the streaming-branch failure.
        await writeLinked('xref-index.json', JSON.stringify({ index: {} }));
        const res = runBuilder();
        expect(res.status).toBe(1);
        expect(`${res.stdout}${res.stderr}`).toMatch(/Required file compounds-search\.jsonl/);
    });

    it('exit 1 when xref-index.json (gzip-branch required) is absent', async () => {
        await writeLinked('compounds-search.jsonl', JSON.stringify({ pubchem_cid: 2244, id: 'x' }) + '\n');
        const res = runBuilder();
        expect(res.status).toBe(1);
        expect(`${res.stdout}${res.stderr}`).toMatch(/Required file xref-index\.json/);
    });

    it('does NOT fail for the missing-projection reason when BOTH projections are present', async () => {
        await writeLinked('compounds-search.jsonl', JSON.stringify({ pubchem_cid: 2244, id: 'x' }) + '\n');
        await writeLinked('xref-index.json', JSON.stringify({ index: {} }));
        const res = runBuilder();
        // It may still exit 0 (success) here; the key assertion is that NEITHER
        // projection triggered the required-file refusal.
        expect(`${res.stdout}${res.stderr}`).not.toMatch(/Required file compounds-search\.jsonl/);
        expect(`${res.stdout}${res.stderr}`).not.toMatch(/Required file xref-index\.json/);
    });
});
