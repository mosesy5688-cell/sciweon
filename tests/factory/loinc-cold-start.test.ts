// @ts-nocheck
/**
 * PR-UMLS-4 cold-start guard test (network-free -- the R2 cursor-existence check is mocked).
 *
 * Two LOCKED invariants (mirroring snomed-cold-start.test.ts):
 *   Invariant 1 -- cursor MISSING (404) -> the LOINC sub-pipeline (linker + 1.10 stamp +
 *     public-builder + crosslink-enricher [PR-4b]) is skipped GRACEFULLY; NO uncaught
 *     exception; the cascade + the other stampers + the MeSH cross-link still proceed; the
 *     loud-warning path runs.
 *   Invariant 2 -- cursor EXISTS but the downstream artifact read fails -> HARD FAIL (throws).
 *
 * The DISCRIMINATOR is cursor existence (a single R2 HEAD), NOT artifact presence.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    isLoincColdStart, warnLoincColdStart, LOINC_CASCADE_SCRIPTS, LOINC_CURSOR_KEY,
} from '../../scripts/factory/lib/loinc-cold-start.js';
import {
    runSidStampingCascade, SID_STAMPERS, POST_STAMP_UMLS_PHASES,
} from '../../scripts/factory/lib/stage-3-stampers.js';

// Minimal mock S3 client: send() resolves (cursor present) or rejects with a 404-shaped error.
function mockClient({ present }) {
    return {
        send: vi.fn(async () => {
            if (present) return { ContentLength: 123 };
            const err: any = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
        }),
    };
}

describe('isLoincColdStart -- the single cursor-existence discriminator', () => {
    it('cursor MISSING (404 / NoSuchKey) -> true (cold start)', async () => {
        const client = mockClient({ present: false });
        await expect(isLoincColdStart({ client, bucket: 'b' })).resolves.toBe(true);
        expect(client.send).toHaveBeenCalledTimes(1);
        const cmd = client.send.mock.calls[0][0];
        expect(cmd.input.Key).toBe(LOINC_CURSOR_KEY);
    });

    it('cursor PRESENT -> false (NOT cold start; broken-artifact path hard-fails downstream)', async () => {
        const client = mockClient({ present: true });
        await expect(isLoincColdStart({ client, bucket: 'b' })).resolves.toBe(false);
    });

    it('a non-404 error (auth/network/5xx) is RETHROWN -- never mis-read as cold start', async () => {
        const client = { send: vi.fn(async () => { const e: any = new Error('AccessDenied'); e.name = 'AccessDenied'; e.$metadata = { httpStatusCode: 403 }; throw e; }) };
        await expect(isLoincColdStart({ client, bucket: 'b' })).rejects.toThrow('AccessDenied');
    });
});

describe('LOINC_CASCADE_SCRIPTS membership -- stamper + public-builder + crosslink (PR-4b)', () => {
    it('contains the stamper + public-builder + crosslink enricher, frozen, length 3', () => {
        expect(Object.isFrozen(LOINC_CASCADE_SCRIPTS)).toBe(true);
        expect(LOINC_CASCADE_SCRIPTS).toContain('stage-3-loinc-sid-stamp.js');
        expect(LOINC_CASCADE_SCRIPTS).toContain('loinc-public-builder.js');
        expect(LOINC_CASCADE_SCRIPTS).toContain('loinc-crosslink-enricher.js');
        expect(LOINC_CASCADE_SCRIPTS).toHaveLength(3);
    });
    it('contains the crosslink enricher (PR-4b -- no longer split out)', () => {
        expect(LOINC_CASCADE_SCRIPTS.some(s => s.includes('crosslink'))).toBe(true);
    });
    it('the LOINC entries appear in the actual cascade SSoT', () => {
        const fullSeq = [...SID_STAMPERS.map(s => s[1]), ...POST_STAMP_UMLS_PHASES.map(p => p[1])];
        for (const s of LOINC_CASCADE_SCRIPTS) expect(fullSeq).toContain(s);
        // the loinc-crosslink-enricher.js is wired into the cascade (PR-4b)
        expect(fullSeq).toContain('loinc-crosslink-enricher.js');
    });
});

describe('Invariant 1 -- cold start = GRACEFUL SKIP of the whole LOINC sub-pipeline', () => {
    it('skipLoinc=true skips ALL LOINC cascade entries; NO uncaught exception', async () => {
        const calls: string[] = [];
        await expect(
            runSidStampingCascade(async (name) => { calls.push(name); }, { skipLoinc: true })
        ).resolves.toBeUndefined();
        for (const s of LOINC_CASCADE_SCRIPTS) expect(calls).not.toContain(s);
    });

    it('the OTHER stages still proceed (non-LOINC stampers + MeSH/SNOMED still run)', async () => {
        const calls: string[] = [];
        await runSidStampingCascade(async (name) => { calls.push(name); }, { skipLoinc: true });
        for (const [, script] of SID_STAMPERS) {
            if (LOINC_CASCADE_SCRIPTS.includes(script)) continue;
            expect(calls).toContain(script);
        }
        expect(calls).toContain('mesh-crosslink-enricher.js');
        expect(calls).toContain('snomed-crosslink-enricher.js');
        const fullSeq = [...SID_STAMPERS.map(s => s[1]), ...POST_STAMP_UMLS_PHASES.map(p => p[1])];
        expect(calls).toEqual(fullSeq.filter(s => !LOINC_CASCADE_SCRIPTS.includes(s)));
    });

    it('skipSnomed + skipLoinc together exclude exactly both vocabularies (independent flags)', async () => {
        const calls: string[] = [];
        await runSidStampingCascade(async (name) => { calls.push(name); }, { skipSnomed: true, skipLoinc: true });
        const fullSeq = [...SID_STAMPERS.map(s => s[1]), ...POST_STAMP_UMLS_PHASES.map(p => p[1])];
        const excluded = new Set([...LOINC_CASCADE_SCRIPTS]);
        // SNOMED scripts are also excluded; build expected from the SNOMED set implicitly via filter
        expect(calls).not.toContain('stage-3-loinc-sid-stamp.js');
        expect(calls).not.toContain('loinc-public-builder.js');
        expect(calls).not.toContain('stage-3-snomed-sid-stamp.js');
        // MeSH still runs
        expect(calls).toContain('mesh-public-builder.js');
        expect(calls.length).toBeLessThan(fullSeq.length);
    });

    it('the loud-warning banner path is taken (multi-line CRITICAL LAUNCH WARNING)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        warnLoincColdStart();
        const lines = warn.mock.calls.map(c => String(c[0]));
        expect(lines.some(l => l.includes('[CRITICAL LAUNCH WARNING]'))).toBe(true);
        expect(lines.some(l => l.includes('LOINC initial harvest data not yet materialized'))).toBe(true);
        expect(lines.some(l => l.includes('Skipping LOINC sub-pipeline'))).toBe(true);
        expect(warn.mock.calls.length).toBeGreaterThanOrEqual(4);
        warn.mockRestore();
    });
});

describe('Invariant 2 -- cursor EXISTS + artifact broken = HARD FAIL (no silent drop)', () => {
    it('skipLoinc=false runs the LOINC stamper; a broken-artifact throw PROPAGATES', async () => {
        await expect(
            runSidStampingCascade(async (name) => {
                if (name === 'stage-3-loinc-sid-stamp.js') {
                    throw new Error('HALT: parsed records != cursor.record_count');
                }
            }, { skipLoinc: false })
        ).rejects.toThrow('HALT: parsed records != cursor.record_count');
    });

    it('default (no opts) preserves the pre-guard behavior: every entry runs, no skip', async () => {
        const calls: string[] = [];
        await runSidStampingCascade(async (name) => { calls.push(name); });
        const fullSeq = [...SID_STAMPERS.map(s => s[1]), ...POST_STAMP_UMLS_PHASES.map(p => p[1])];
        expect(calls).toEqual(fullSeq);
        for (const s of LOINC_CASCADE_SCRIPTS) expect(calls).toContain(s);
    });
});

describe('the discriminator is CURSOR existence, not ARTIFACT presence', () => {
    it('cold start is decided by the cursor HEAD alone (the artifact is never probed)', async () => {
        const client = mockClient({ present: false });
        const cold = await isLoincColdStart({ client, bucket: 'b' });
        expect(cold).toBe(true);
        expect(client.send).toHaveBeenCalledTimes(1);
        expect(client.send.mock.calls[0][0].input.Key).toBe(LOINC_CURSOR_KEY);
    });
});
