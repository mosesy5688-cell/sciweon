/**
 * RC-3B-P0B -- temporary R2 session-token FORMAT gate (C4-E-T1; PURE Node).
 *
 * Cloudflare temporary R2 credentials deliver a SESSION TOKEN that the harness
 * consumes as the AWS `sessionToken` (transmitted as the X-Amz-Security-Token
 * header). Ground-truth shape:
 *
 *     sessionToken = base64("jwt/" + signed-JWT)
 *
 * i.e. the secret value is canonical standard base64 whose decoded bytes are a
 * literal `jwt/` prefix followed by a three-segment JWT (each segment a non-empty
 * base64url run). This module enforces that FORMAT ONLY. It NEVER:
 *   - verifies a JWT signature,
 *   - parses / inspects any JWT header or claim,
 *   - reads or accepts a PARENT (long-term) token,
 *   - performs any network or crypto beyond a base64 decode.
 *
 * On ANY failure it throws a FIXED error code and NOTHING else -- never the token,
 * the decoded value, a JWT segment, a claim, or any fragment of them. On success
 * it returns the raw token unchanged; callers consume it as a credential and MUST
 * NOT log it. Node built-ins only (Buffer) -- no @aws-sdk, no external deps.
 */

export const SESSION_TOKEN_ENV = 'R2_SESSION_TOKEN';

// The ONLY strings this module ever throws. NOTHING derived from the input is
// ever appended -- these are the complete, fixed failure messages.
const CODE = '[RC3B CRED] SESSION_TOKEN_INVALID';
export const SESSION_TOKEN_ERRORS = Object.freeze({
    MISSING: `${CODE}: MISSING`,
    NOT_BASE64: `${CODE}: NOT_BASE64`,
    NOT_JWT: `${CODE}: NOT_JWT`,
});

// Canonical STANDARD base64 (NOT base64url): A-Z a-z 0-9 + / with 0-2 '=' pad.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Decoded value MUST be EXACTLY `jwt/<seg>.<seg>.<seg>`; each segment a non-empty
// base64url run. No signature/claim semantics are implied or checked.
const JWT_RE = /^jwt\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * True only for CANONICAL standard base64: correct alphabet, length a multiple of
 * 4, AND a byte-exact re-encode round-trip (so non-canonical padding / altered
 * trailing bits are rejected). No part of `s` is ever logged.
 * @param {string} s
 * @returns {boolean}
 */
function isCanonicalBase64(s) {
    if (s.length === 0 || s.length % 4 !== 0) return false;
    if (!BASE64_RE.test(s)) return false;
    let decoded;
    try { decoded = Buffer.from(s, 'base64'); } catch { return false; }
    // Node decodes leniently; require the decoded bytes to re-encode to the EXACT
    // same string, which only canonical base64 does.
    return decoded.toString('base64') === s;
}

/**
 * Assert the environment carries a valid temporary R2 session token.
 *
 * @param {object} env  defaults to process.env; injected in tests
 * @returns {string} the raw, valid session token (caller uses it as sessionToken)
 * @throws {Error} message is EXACTLY one fixed SESSION_TOKEN_ERRORS code; it never
 *                 contains the token, the decoded value, or any JWT fragment.
 */
export function assertValidSessionToken(env = process.env) {
    const raw = env ? env[SESSION_TOKEN_ENV] : undefined;
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error(SESSION_TOKEN_ERRORS.MISSING);
    }
    if (!isCanonicalBase64(raw)) {
        throw new Error(SESSION_TOKEN_ERRORS.NOT_BASE64);
    }
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    if (!JWT_RE.test(decoded)) {
        throw new Error(SESSION_TOKEN_ERRORS.NOT_JWT);
    }
    return raw;
}
