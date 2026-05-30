/**
 * UMLS-authenticated download helper (PR-RXN-2b).
 *
 * The Full RxNorm RRF release is UMLS-license-gated (unlike the public-domain
 * Prescribable Subset). PR-RXN-2a diagnostic (runs 26667631988 + 26668222048)
 * probed both NLM download mechanisms head-to-head: the apiKey download proxy
 * AND the legacy CAS TGT flow both returned 200. The apiKey proxy is chosen
 * (single stateless request, no ticket dance). This is the SSoT wrapper used by
 * rxnorm-probe.js + rxnorm-harvest.js (download) and rxnorm-release-discovery.js
 * (auth'd HEAD/Range probe).
 *
 * Fail-closed: throws BEFORE any network call when UMLS_API_KEY is absent, so a
 * mis-provisioned runner fails fast with a clear message instead of emitting
 * unauthenticated requests that NLM 403s.
 */

const DOWNLOAD_PROXY = 'https://uts-ws.nlm.nih.gov/download';

export function umlsApiKey() {
    const key = process.env.UMLS_API_KEY;
    if (!key) throw new Error('[UMLS-AUTH] UMLS_API_KEY env required (Full RxNorm RRF is UMLS-license-gated)');
    return key;
}

/**
 * Wrap an inner NLM download URL in the UMLS apiKey download proxy.
 * @param {string} innerUrl  the canonical NLM artifact URL (e.g. the Full RRF zip)
 * @returns {string} the authenticated proxy URL to GET/probe
 */
export function umlsDownloadUrl(innerUrl) {
    if (typeof innerUrl !== 'string' || innerUrl.length === 0) {
        throw new Error('[UMLS-AUTH] innerUrl must be a non-empty string');
    }
    return `${DOWNLOAD_PROXY}?url=${encodeURIComponent(innerUrl)}&apiKey=${encodeURIComponent(umlsApiKey())}`;
}
