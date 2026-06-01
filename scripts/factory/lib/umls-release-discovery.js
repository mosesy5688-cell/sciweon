/**
 * UMLS Metathesaurus release discovery (PR-UMLS-1; extracted from
 * diagnostic-umls-mrconso-probe.js PR-UMLS-0a, single SSoT).
 *
 * BYTE-probes candidate full-release inner URLs (newest-first) through the apiKey proxy
 * and returns the FIRST whose head looks like a real ZIP (PK magic + size floor) -- NOT
 * the first HTTP 200, because the proxy returns 200 + a ~196-byte stub for a non-existent
 * inner URL (PR-UMLS-0 Bug 1, which locked the phantom 2026AB). The diagnostic probe AND
 * the production umls-probe.js both consume these so discovery logic cannot drift.
 */

import { umlsDownloadUrl } from './umls-auth.js';
import {
    candidateMetathesaurusUrls, classifyArchiveHead,
} from './umls-mrconso-probe.js';

const HEAD_PROBE_BYTES = 512;     // bytes read off the stream per candidate during discovery
const FAIL_DUMP_BYTES = 2048;     // bytes captured for the terminal discovery-fail dump

/**
 * Byte-reading probe: fetch follows the proxy's 302 redirect, read only the first ~512
 * bytes off the stream then cancel() -- the multi-GB body is NEVER downloaded here.
 * Reading the magic bytes (not status) is the fix for the proxy false-200 stub.
 */
export async function probeArchive(proxyUrl) {
    const res = await fetch(proxyUrl);
    let head = Buffer.alloc(0);
    try {
        if (res.body) {
            const reader = res.body.getReader();
            while (head.length < HEAD_PROBE_BYTES) {
                const { done, value } = await reader.read();
                if (done) break;
                head = Buffer.concat([head, Buffer.from(value)]);
            }
            try { await reader.cancel(); } catch { /* ignore */ }
        }
    } catch { /* partial head is fine for classification */ }
    return {
        status: res.status,
        finalUrl: res.url,
        contentType: res.headers.get('content-type') || '',
        contentLength: res.headers.get('content-length'),
        head: head.subarray(0, HEAD_PROBE_BYTES),
    };
}

/**
 * Discover the release: BYTE-probe candidates (or the operator override) and return the
 * FIRST whose head looks like a real ZIP (looks_real === true), NOT the first 200. Returns
 * the inner URL string, or null when no candidate looks real (dumps the last body head as
 * evidence per Bug 2: never discard the bytes).
 */
export async function discoverRelease({ fullUrl, now }) {
    const candidates = fullUrl ? [fullUrl] : candidateMetathesaurusUrls(now);
    let last = null;
    for (const inner of candidates) {
        let p;
        try { p = await probeArchive(umlsDownloadUrl(inner)); }
        catch (e) {
            console.log(`[UMLS-PROBE] release-candidate status=err:${e.message} | inner=${inner}`);
            continue;
        }
        last = { inner, p };
        const c = classifyArchiveHead(p.head, p.contentLength);
        console.log(`[UMLS-PROBE] release-candidate status=${p.status} magic=${c.magic_hex} looks_real=${c.looks_real} content-length=${p.contentLength ?? 'none'} content-type=${p.contentType} | inner=${inner}`);
        if (c.looks_real) return inner;
    }
    if (last) {
        const headText = last.p.head.subarray(0, FAIL_DUMP_BYTES).toString('utf-8');
        console.error('[UMLS-PROBE] DISCOVERY-FAIL no candidate looks like a real ZIP release.');
        console.error(`[UMLS-PROBE]   last-status=${last.p.status} final-url=${last.p.finalUrl}`);
        console.error(`[UMLS-PROBE]   content-type=${last.p.contentType} content-length=${last.p.contentLength ?? 'none'}`);
        console.error(`[UMLS-PROBE]   first-bytes-hex=${last.p.head.subarray(0, 4).toString('hex')}`);
        console.error(`[UMLS-PROBE]   body-head(<=${FAIL_DUMP_BYTES}B as text):\n${headText}`);
    }
    return null;
}

/**
 * Parse the release tag (e.g. `2026AA`) out of a resolved inner URL. The canonical UMLS
 * full-release path is .../umls/kss/<REL>/umls-<REL>-metathesaurus[-full].zip; we read the
 * tag from the filename segment (`umls-<REL>-metathesaurus`) so a discovered URL -- NOT a
 * hardcoded constant -- is the SSoT for the release. Returns null when no tag is present.
 */
export function parseReleaseTag(innerUrl) {
    if (typeof innerUrl !== 'string') return null;
    const m = innerUrl.match(/umls-(\d{4}[A-Z]{2})-metathesaurus/);
    return m ? m[1] : null;
}
