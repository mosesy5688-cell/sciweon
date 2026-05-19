/**
 * Tests for V0.5.7 ChEMBL InChIKey negative cache.
 *
 * Anchored in 6-Wave plan Wave H2b-4 stage-2 runtime optimization.
 * partitionInchiKeys is the pure decision surface — it classifies an
 * input array of InChIKeys against the negative-cache Set so the
 * enricher can skip known negatives entirely.
 *
 * loadNegativeCache / saveNegativeCache are thin I/O wrappers; their
 * happy-path is exercised via cron, and missing-file handling is
 * verified inline here via fs operations on the OS tmp dir.
 */

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import {
    partitionInchiKeys,
    loadNegativeCache,
    saveNegativeCache,
} from '../../scripts/factory/lib/chembl-negative-cache.js';

describe('partitionInchiKeys', () => {
    it('empty negativeSet -> all keys land in toQuery', () => {
        const { toQuery, cachedNegatives } = partitionInchiKeys(
            ['KEY1', 'KEY2', 'KEY3'], new Set(),
        );
        expect(toQuery).toEqual(['KEY1', 'KEY2', 'KEY3']);
        expect(cachedNegatives).toEqual([]);
    });

    it('negative set contains all -> all in cachedNegatives', () => {
        const { toQuery, cachedNegatives } = partitionInchiKeys(
            ['KEY1', 'KEY2'], new Set(['KEY1', 'KEY2']),
        );
        expect(toQuery).toEqual([]);
        expect(cachedNegatives).toEqual(['KEY1', 'KEY2']);
    });

    it('mixed -> correct partition, preserves input order', () => {
        const { toQuery, cachedNegatives } = partitionInchiKeys(
            ['KEY1', 'KEY2', 'KEY3', 'KEY4'], new Set(['KEY2', 'KEY4']),
        );
        expect(toQuery).toEqual(['KEY1', 'KEY3']);
        expect(cachedNegatives).toEqual(['KEY2', 'KEY4']);
    });

    it('null / non-array inchikeys -> empty result, no crash', () => {
        expect(partitionInchiKeys(null, new Set())).toEqual({ toQuery: [], cachedNegatives: [] });
        expect(partitionInchiKeys(undefined, new Set())).toEqual({ toQuery: [], cachedNegatives: [] });
    });

    it('skips falsy entries (null / empty string)', () => {
        const { toQuery, cachedNegatives } = partitionInchiKeys(
            ['KEY1', null, '', 'KEY2'], new Set(),
        );
        expect(toQuery).toEqual(['KEY1', 'KEY2']);
        expect(cachedNegatives).toEqual([]);
    });

    it('duplicate InChIKey appears in output as many times as input (caller dedupe)', () => {
        const { toQuery } = partitionInchiKeys(
            ['KEY1', 'KEY1', 'KEY2'], new Set(),
        );
        expect(toQuery).toEqual(['KEY1', 'KEY1', 'KEY2']);
    });

    it('negative set with values not in input -> no effect on outputs', () => {
        const { toQuery, cachedNegatives } = partitionInchiKeys(
            ['KEY1'], new Set(['UNRELATED1', 'UNRELATED2']),
        );
        expect(toQuery).toEqual(['KEY1']);
        expect(cachedNegatives).toEqual([]);
    });

    it('missing negativeSet (undefined) treated as empty', () => {
        const { toQuery } = partitionInchiKeys(['KEY1'], undefined);
        expect(toQuery).toEqual(['KEY1']);
    });
});

describe('loadNegativeCache / saveNegativeCache (integration of local I/O)', () => {
    it('loadNegativeCache returns empty Set when file is missing', async () => {
        const missing = path.join(os.tmpdir(), `sciweon-chembl-cache-missing-${Date.now()}.json`);
        const set = await loadNegativeCache(missing);
        expect(set).toBeInstanceOf(Set);
        expect(set.size).toBe(0);
    });

    it('save -> load roundtrip preserves entries', async () => {
        const file = path.join(os.tmpdir(), `sciweon-chembl-cache-rt-${Date.now()}.json`);
        await saveNegativeCache(file, new Set(['KEY1', 'KEY2', 'KEY3']));
        const set = await loadNegativeCache(file);
        expect(set.size).toBe(3);
        expect(set.has('KEY1')).toBe(true);
        expect(set.has('KEY2')).toBe(true);
        expect(set.has('KEY3')).toBe(true);
        await fs.unlink(file);
    });
});
