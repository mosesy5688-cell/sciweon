/**
 * V0.5.7 — JSON response guard.
 *
 * Adapter `fetchJson` helpers historically called `res.json()` directly,
 * so when an upstream API returned HTML (retirement notice / load-balancer
 * default page / WAF block page) the parse failure surfaced as
 * "SyntaxError: Unexpected token <" — useless for operator triage.
 *
 * This pure helper inspects a response's content-type + body preview and
 * returns an actionable classification, so adapters can throw with the
 * URL + reason instead of a generic JSON parse error.
 *
 * Detection (in priority order):
 *   1. Content-Type contains "text/html"        -> 'html_content_type'
 *   2. Body starts with <!doctype html or <html -> 'html_body'
 *   3. otherwise                                -> 'ok'
 *
 * Pure function — no I/O. Caller decides whether to throw or fall back.
 * Wired into nci-thesaurus-adapter.js in V0.5.7 H2b-3 (the retired EVS
 * endpoint manifested as HTML retirement notice with HTTP 200).
 */

export function detectHtmlResponse(contentType, bodyPreview) {
    const ct = String(contentType ?? '').toLowerCase();
    if (ct.includes('text/html')) {
        return { kind: 'html_content_type', contentType: ct };
    }
    const head = String(bodyPreview ?? '').trim().slice(0, 80).toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
        return { kind: 'html_body' };
    }
    return { kind: 'ok' };
}
