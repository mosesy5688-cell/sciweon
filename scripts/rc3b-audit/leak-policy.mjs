/**
 * RC-3B-P0B -- leak-scan policy (versioned + hashed).
 *
 * The evidence artifact is a machine structure of locators, counts, hashes,
 * enums, and committed field-path names -- NEVER payload-derived free text. The
 * policy therefore encodes two independent rules:
 *   1. FORBIDDEN PROPERTY NAMES -- exact property names that would imply a
 *      payload value (text/body/content/...); none may appear in the artifact.
 *   2. STRING-VALUE SHAPE -- every string leaf must be a compact locator/token:
 *      printable ASCII, NO whitespace, within a length bound. Any prose value
 *      (which necessarily contains spaces / non-ASCII) fails. This is what makes
 *      a deliberately poisoned free-text value FAIL the scan (negative control).
 */

import { createHash } from 'crypto';

export const LEAK_SCANNER_NAME = 'rc3b-leak-scanner';
export const LEAK_SCANNER_VERSION = '0.2.0';

export const LOCATOR_SEMANTIC_PATTERN_IDS = Object.freeze({
    LAYOUT_VERSION: 'LAYOUT_VERSION_V2', SNAPSHOT_ID: 'SNAPSHOT_ID_V2',
    OBJECT_PREFIX: 'OBJECT_PREFIX_V2', MANIFEST_KEY: 'MANIFEST_KEY_PATHSAFE',
    OBJECT_KEY: 'R2_DATA_KEY_PATHSAFE', RELEASE_TOKEN: 'RELEASE_TOKEN_SEGMENT',
    SNAPSHOT_DATE: 'ISO_DATE', SHA256_HEX: 'SHA256_HEX', RECORD_COUNT: 'NONNEG_INTEGER',
});

export const MAX_STRING_VALUE_LENGTH = 512;
// A run of this many non-whitespace chars in a LOG line signals a dumped blob.
export const LOG_BLOB_RUN_THRESHOLD = 200;
export const MAX_LOG_LINE_LENGTH = 4096;

// Exact (not substring) property names that must never appear in the artifact.
export const FORBIDDEN_PROPERTY_NAMES = Object.freeze([
    'text', 'body', 'content', 'contents', 'value', 'values', 'snippet',
    'excerpt', 'sample', 'sample_text', 'raw', 'raw_text', 'raw_body',
    'payload', 'payload_text', 'payload_body', 'abstract', 'free_text',
    'note_text', 'decoded', 'decoded_text', 'string_value', 'message_text',
    'record', 'record_text', 'row', 'row_text', 'field_value', 'title_text',
]);

// Printable ASCII, no whitespace, no control chars.
const ALLOWED_STRING_RE = /^[\x21-\x7e]*$/;

/** True when a string leaf is an acceptable compact locator/token. */
export function isAllowedStringValue(s) {
    return typeof s === 'string' && s.length <= MAX_STRING_VALUE_LENGTH && ALLOWED_STRING_RE.test(s);
}

/** The canonical, hashable policy object (bump version on any change). */
export function leakPolicyObject() {
    return {
        scanner_name: LEAK_SCANNER_NAME,
        scanner_version: LEAK_SCANNER_VERSION,
        max_string_value_length: MAX_STRING_VALUE_LENGTH,
        log_blob_run_threshold: LOG_BLOB_RUN_THRESHOLD,
        max_log_line_length: MAX_LOG_LINE_LENGTH,
        forbidden_property_names: [...FORBIDDEN_PROPERTY_NAMES].sort(),
        allowed_string_pattern: ALLOWED_STRING_RE.source,
        locator_semantic_pattern_ids: Object.entries(LOCATOR_SEMANTIC_PATTERN_IDS).sort(([a], [b]) => a.localeCompare(b)),
    };
}

export function leakPolicySha256() {
    return createHash('sha256').update(Buffer.from(JSON.stringify(leakPolicyObject()), 'utf-8')).digest('hex');
}
