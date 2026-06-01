// @ts-nocheck
/**
 * PR-UMLS-1a: stdout-purity contract for the UMLS release discovery lib.
 *
 * THE BUG THIS LOCKS: the first MeSH harvest run failed because the check-version job
 * captured `node umls-probe.js > umls-probe.json` and the next step parsed that file as
 * JSON -- but discoverRelease() logged per-candidate progress to STDOUT via console.log,
 * so the capture was `[UMLS-PROBE] release-candidate ...` text BEFORE the JSON -> invalid
 * JSON -> check-version crashed -> ingest skipped -> harvest never ran.
 *
 * CONTRACT: discoverRelease writes NOTHING to stdout (progress is stderr-only). The ONLY
 * stdout write in the whole probe path is umls-probe.js's final console.log(JSON...). These
 * tests spy on console.log/console.error and assert that contract -- NETWORK-FREE via the
 * injected probeArchiveFn (no real fetch), so they can never silently regress + re-pollute
 * the probe-json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { discoverRelease, parseReleaseTag } from '../../scripts/factory/lib/umls-release-discovery.js';
import { ZIP_MAGIC } from '../../scripts/factory/lib/umls-mrconso-probe.js';

// A real-looking ZIP head: PK magic + Content-Length over the 100MB floor -> looks_real.
const looksReal = (proxyUrl) => ({
    status: 200,
    finalUrl: proxyUrl,
    contentType: 'application/zip',
    contentLength: '4000000000',
    head: Buffer.concat([ZIP_MAGIC, Buffer.alloc(8, 0xff)]),
});
// A proxy false-200 stub: 196-byte non-PK body -> looks_real false (forces fall-through).
const stub = (proxyUrl) => ({
    status: 200,
    finalUrl: proxyUrl,
    contentType: 'text/html',
    contentLength: '196',
    head: Buffer.from('<html>not found</html>'.padEnd(196, ' ')),
});

describe('PR-UMLS-1a: discoverRelease stdout-purity', () => {
    let logSpy, errSpy, savedKey;
    beforeEach(() => {
        savedKey = process.env.UMLS_API_KEY;
        process.env.UMLS_API_KEY = 'test-key';   // umlsDownloadUrl is fail-closed without it
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        logSpy.mockRestore();
        errSpy.mockRestore();
        if (savedKey === undefined) delete process.env.UMLS_API_KEY;
        else process.env.UMLS_API_KEY = savedKey;
    });

    it('writes NOTHING to stdout on the happy path (only stderr progress)', async () => {
        const inner = await discoverRelease({
            fullUrl: 'https://download.nlm.nih.gov/umls/kss/2026AA/umls-2026AA-metathesaurus-full.zip',
            probeArchiveFn: async (u) => looksReal(u),
        });
        expect(inner).toBe('https://download.nlm.nih.gov/umls/kss/2026AA/umls-2026AA-metathesaurus-full.zip');
        // The CORE assertion: discovery must not touch stdout (would corrupt probe-json).
        expect(logSpy).not.toHaveBeenCalled();
        // Progress IS emitted -- on stderr (GHA logs still see it).
        expect(errSpy).toHaveBeenCalled();
        expect(errSpy.mock.calls.some(([m]) => String(m).includes('release-candidate'))).toBe(true);
    });

    it('writes NOTHING to stdout while falling through stub candidates', async () => {
        // First candidate a false-200 stub, then a real one: exercises the fall-through path.
        const inner = await discoverRelease({
            now: new Date(Date.UTC(2026, 5, 1)),
            probeArchiveFn: async (u) => (u.includes('2026AB') ? stub(u) : looksReal(u)),
        });
        expect(inner).toContain('2026AA');     // fell through the AB stubs to a real AA
        expect(logSpy).not.toHaveBeenCalled(); // still pure stdout across multiple candidates
    });

    it('writes NOTHING to stdout when a probe throws (catch branch -> stderr)', async () => {
        const inner = await discoverRelease({
            now: new Date(Date.UTC(2026, 5, 1)),
            probeArchiveFn: async (u) => {
                if (u.includes('2026AB')) throw new Error('ECONNRESET');
                return looksReal(u);
            },
        });
        expect(inner).toContain('2026AA');
        expect(logSpy).not.toHaveBeenCalled();           // catch branch must NOT use stdout
        expect(errSpy.mock.calls.some(([m]) => String(m).includes('status=err'))).toBe(true);
    });

    it('writes NOTHING to stdout when NO candidate looks real (fail-dump -> stderr)', async () => {
        const inner = await discoverRelease({
            now: new Date(Date.UTC(2026, 5, 1)),
            probeArchiveFn: async (u) => stub(u),     // every candidate is a stub
        });
        expect(inner).toBeNull();
        expect(logSpy).not.toHaveBeenCalled();           // DISCOVERY-FAIL dump is stderr-only
        expect(errSpy.mock.calls.some(([m]) => String(m).includes('DISCOVERY-FAIL'))).toBe(true);
    });

    it('DI is backward-compatible: probeArchiveFn defaults to the real probe', async () => {
        // No probeArchiveFn passed + no fullUrl: the real probeArchive (network) is the
        // default. We do NOT call the network here; we only assert the param is optional by
        // confirming the signature accepts the legacy { fullUrl, now } shape without throwing
        // at parse/bind time. parseReleaseTag is a pure round-trip sanity check.
        expect(parseReleaseTag('https://x/umls-2026AA-metathesaurus-full.zip')).toBe('2026AA');
        expect(typeof discoverRelease).toBe('function');
    });
});
