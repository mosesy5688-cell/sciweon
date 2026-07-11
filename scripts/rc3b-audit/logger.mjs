/**
 * RC-3B-P0B -- structural logger that CANNOT emit body bytes.
 *
 * Every log line is `[RC3B] <kind> k=token k2=token2`. Field values are coerced
 * to COMPACT TOKENS by safeToken(): a Buffer / Uint8Array becomes `<bytes:N>`;
 * a string that contains whitespace or is long becomes `<redacted:len=N,
 * sha256=...>`; numbers / booleans / short tokens pass through. There is no code
 * path that writes raw payload bytes or a payload-derived string to a line, so
 * "body bytes never enter logs" holds structurally, not by discipline.
 */

import { createHash } from 'crypto';

const MAX_TOKEN_LEN = 128;

export function safeToken(v) {
    if (v == null) return 'null';
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<bytes:${v.length}>`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    if (/\s/.test(s) || s.length > MAX_TOKEN_LEN || !/^[\x21-\x7e]*$/.test(s)) {
        const sha = createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex').slice(0, 16);
        return `<redacted:len=${s.length},sha256=${sha}>`;
    }
    return s;
}

export class StructuralLogger {
    constructor() { this._lines = []; }

    event(kind, fields = {}) {
        const parts = [`[RC3B]`, String(kind).replace(/\s+/g, '_')];
        for (const [k, v] of Object.entries(fields)) {
            parts.push(`${String(k).replace(/\s+/g, '_')}=${safeToken(v)}`);
        }
        this._lines.push(parts.join(' '));
    }

    get lines() { return [...this._lines]; }
}
