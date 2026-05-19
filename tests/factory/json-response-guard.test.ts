/**
 * Tests for V0.5.7 JSON response guard.
 *
 * Anchored in Wave H2b-3 nci-thesaurus fix: retired EVS endpoint
 * returned HTML 200 instead of JSON, and the bare `res.json()` parse
 * failure produced an opaque "Unexpected token <" message. The new
 * pure detector emits an actionable classification so future API
 * retirements / WAF blocks / load-balancer default pages surface
 * with a clear log line.
 */

import { describe, it, expect } from 'vitest';
import { detectHtmlResponse } from '../../scripts/factory/lib/json-response-guard.js';

describe('detectHtmlResponse', () => {
    it('content-type text/html with charset -> html_content_type', () => {
        const r = detectHtmlResponse('text/html; charset=utf-8', '<html><body>...</body></html>');
        expect(r.kind).toBe('html_content_type');
        expect(r.contentType).toContain('text/html');
    });

    it('server lies about content-type (application/json) but body is HTML -> html_body', () => {
        const r = detectHtmlResponse('application/json', '<!doctype html><html>...</html>');
        expect(r.kind).toBe('html_body');
    });

    it('legitimate JSON content + body -> ok', () => {
        const r = detectHtmlResponse('application/json', '{"ok": true}');
        expect(r.kind).toBe('ok');
    });

    it('empty content-type and empty body -> ok (cannot determine, optimistic)', () => {
        const r = detectHtmlResponse('', '');
        expect(r.kind).toBe('ok');
    });

    it('null content-type with whitespaced HTML body (case-insensitive) -> html_body', () => {
        const r = detectHtmlResponse(null, '   <HTML lang="en">retired</HTML>');
        expect(r.kind).toBe('html_body');
    });

    it('text/html content-type wins regardless of (null) body', () => {
        const r = detectHtmlResponse('text/html', null);
        expect(r.kind).toBe('html_content_type');
    });
});
