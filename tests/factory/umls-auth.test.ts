// @ts-nocheck
/**
 * PR-RXN-2b: umls-auth fail-closed + proxy-URL shape.
 *
 * Locks the contract that a missing UMLS_API_KEY aborts BEFORE any network I/O
 * (no unauthenticated request that NLM would 403), and that the apiKey download
 * proxy URL is correctly encoded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { umlsApiKey, umlsDownloadUrl } from '../../scripts/factory/lib/umls-auth.js';

describe('PR-RXN-2b: umls-auth', () => {
    let saved;
    beforeEach(() => { saved = process.env.UMLS_API_KEY; });
    afterEach(() => {
        if (saved === undefined) delete process.env.UMLS_API_KEY;
        else process.env.UMLS_API_KEY = saved;
    });

    it('fail-closed: throws before any network call when UMLS_API_KEY absent', () => {
        delete process.env.UMLS_API_KEY;
        expect(() => umlsApiKey()).toThrow(/UMLS_API_KEY env required/);
        expect(() => umlsDownloadUrl('https://download.nlm.nih.gov/umls/kss/rxnorm/RxNorm_full_05042026.zip'))
            .toThrow(/UMLS_API_KEY env required/);
    });

    it('wraps inner URL in the apiKey download proxy with encoded params', () => {
        process.env.UMLS_API_KEY = 'KEY 123';
        const inner = 'https://download.nlm.nih.gov/umls/kss/rxnorm/RxNorm_full_05042026.zip';
        const u = umlsDownloadUrl(inner);
        expect(u.startsWith('https://uts-ws.nlm.nih.gov/download?url=')).toBe(true);
        expect(u).toContain(encodeURIComponent(inner));
        expect(u).toContain('apiKey=KEY%20123');
    });

    it('rejects empty / non-string inner URL (before key lookup)', () => {
        process.env.UMLS_API_KEY = 'k';
        expect(() => umlsDownloadUrl('')).toThrow(/non-empty string/);
        expect(() => umlsDownloadUrl(null)).toThrow(/non-empty string/);
    });
});
