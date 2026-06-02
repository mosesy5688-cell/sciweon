// @ts-nocheck
/**
 * PR-UMLS-3 cold-start guard test (network-free -- the R2 cursor-existence check is mocked).
 *
 * Two LOCKED invariants:
 *   Invariant 1 -- cursor MISSING (404) -> the SNOMED sub-pipeline (linker + 1.9 stamp +
 *     public-builder + crosslink) is skipped GRACEFULLY; NO uncaught exception; the cascade +
 *     the 9 non-SNOMED stampers + the MeSH cross-link still proceed; the loud-warning path runs.
 *   Invariant 2 -- cursor EXISTS but the downstream artifact read fails -> HARD FAIL (throws).
 *
 * The DISCRIMINATOR is cursor existence (a single R2 HEAD), NOT artifact presence.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    isSnomedColdStart, warnSnomedColdStart, SNOMED_CASCADE_SCRIPTS, SNOMED_CURSOR_KEY,
} from '../../scripts/factory/lib/snomed-cold-start.js';
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

describe('isSnomedColdStart -- the single cursor-existence discriminator', () => {
    it('cursor MISSING (404 / NoSuchKey) -> true (cold start)', async () => {
        const client = mockClient({ present: false });
        await expect(isSnomedColdStart({ client, bucket: 'b' })).resolves.toBe(true);
        // The probe is a HEAD on the cursor key (not on the artifact data file).
        expect(client.send).toHaveBeenCalledTimes(1);
        const cmd = client.send.mock.calls[0][0];
        expect(cmd.input.Key).toBe(SNOMED_CURSOR_KEY);
    });

    it('cursor PRESENT -> false (NOT cold start; broken-artifact path hard-fails downstream)', async () => {
        const client = mockClient({ present: true });
        await expect(isSnomedColdStart({ client, bucket: 'b' })).resolves.toBe(false);
    });

    it('a non-404 error (auth/network/5xx) is RETHROWN -- never mis-read as cold start', async () => {
        const client = { send: vi.fn(async () => { const e: any = new Error('AccessDenied'); e.name = 'AccessDenied'; e.$metadata = { httpStatusCode: 403 }; throw e; }) };
        await expect(isSnomedColdStart({ client, bucket: 'b' })).rejects.toThrow('AccessDenied');
    });
});

describe('Invariant 1 -- cold start = GRACEFUL SKIP of the whole SNOMED sub-pipeline', () => {
    it('skipSnomed=true skips ALL 3 SNOMED cascade entries; NO uncaught exception', async () => {
        const calls: string[] = [];
        await expect(
            runSidStampingCascade(async (name) => { calls.push(name); }, { skipSnomed: true })
        ).resolves.toBeUndefined();
        for (const s of SNOMED_CASCADE_SCRIPTS) expect(calls).not.toContain(s);
    });

    it('the OTHER stages still proceed (9 non-SNOMED stampers + MeSH cross-link run)', async () => {
        const calls: string[] = [];
        await runSidStampingCascade(async (name) => { calls.push(name); }, { skipSnomed: true });
        // every non-SNOMED stamper runs
        for (const [, script] of SID_STAMPERS) {
            if (SNOMED_CASCADE_SCRIPTS.includes(script)) continue;
            expect(calls).toContain(script);
        }
        // the MeSH cross-link enricher (a post-stamp phase that is NOT SNOMED) still runs
        expect(calls).toContain('mesh-crosslink-enricher.js');
        // exactly the 3 SNOMED entries are excluded from the full sequence
        const fullSeq = [...SID_STAMPERS.map(s => s[1]), ...POST_STAMP_UMLS_PHASES.map(p => p[1])];
        expect(calls).toEqual(fullSeq.filter(s => !SNOMED_CASCADE_SCRIPTS.includes(s)));
    });

    it('the loud-warning banner path is taken (multi-line CRITICAL LAUNCH WARNING)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        warnSnomedColdStart();
        const lines = warn.mock.calls.map(c => String(c[0]));
        expect(lines.some(l => l.includes('[CRITICAL LAUNCH WARNING]'))).toBe(true);
        expect(lines.some(l => l.includes('SNOMED CT initial harvest data not yet materialized'))).toBe(true);
        expect(lines.some(l => l.includes('Skipping SNOMED sub-pipeline'))).toBe(true);
        expect(warn.mock.calls.length).toBeGreaterThanOrEqual(4); // multi-line banner
        warn.mockRestore();
    });
});

describe('Invariant 2 -- cursor EXISTS + artifact broken = HARD FAIL (no silent drop)', () => {
    it('skipSnomed=false runs the SNOMED stamper; a broken-artifact throw PROPAGATES', async () => {
        // Simulate the present-cursor normal path: the 1.9 snomed stamper runs and its
        // downstream read fails (e.g. record-count mismatch) -> the cascade must hard-fail.
        await expect(
            runSidStampingCascade(async (name) => {
                if (name === 'stage-3-snomed-sid-stamp.js') {
                    throw new Error('HALT: parsed records != cursor.record_count');
                }
            }, { skipSnomed: false })
        ).rejects.toThrow('HALT: parsed records != cursor.record_count');
    });

    it('default (no opts) preserves the pre-guard behavior: every entry runs, no skip', async () => {
        const calls: string[] = [];
        await runSidStampingCascade(async (name) => { calls.push(name); });
        const fullSeq = [...SID_STAMPERS.map(s => s[1]), ...POST_STAMP_UMLS_PHASES.map(p => p[1])];
        expect(calls).toEqual(fullSeq);
        for (const s of SNOMED_CASCADE_SCRIPTS) expect(calls).toContain(s);
    });
});

describe('the discriminator is CURSOR existence, not ARTIFACT presence', () => {
    it('cold start is decided by the cursor HEAD alone (the artifact is never probed for the decision)', async () => {
        const client = mockClient({ present: false });
        const cold = await isSnomedColdStart({ client, bucket: 'b' });
        expect(cold).toBe(true);
        // exactly ONE R2 call (the cursor HEAD); the artifact data key is NOT consulted.
        expect(client.send).toHaveBeenCalledTimes(1);
        expect(client.send.mock.calls[0][0].input.Key).toBe(SNOMED_CURSOR_KEY);
    });
});
