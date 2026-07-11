/**
 * RC-3B-P0B -- structural log bundle serializer + hash (PURE).
 *
 * The evidence artifact records `log_bundle_sha256`. To make that hash INDE-
 * PENDENTLY verifiable (not merely a self-asserted 64-hex), the run writes the
 * real log lines to `output/rc3b-p0b-structural-log.jsonl` using serializeLogBundle
 * and records logBundleSha256 over the SAME bytes. A verifier reads the file,
 * recomputes sha256, and re-runs the leak scan on parseLogBundle(fileText) --
 * so a one-byte log mutation or a poisoned line is caught. This module is PURE
 * (crypto only); it holds the single canonical byte serialization of the bundle.
 */

import { createHash } from 'crypto';

/** The canonical byte serialization: newline-joined lines (no trailing newline). */
export function serializeLogBundle(lines = []) {
    return lines.join('\n');
}

/** sha256 over EXACTLY the bytes serializeLogBundle produces (utf-8). */
export function logBundleSha256(lines = []) {
    return createHash('sha256')
        .update(Buffer.from(serializeLogBundle(lines), 'utf-8'))
        .digest('hex');
}

/** Inverse of serializeLogBundle: an empty file is zero lines (not [""]). */
export function parseLogBundle(text) {
    const s = String(text);
    return s.length ? s.split('\n') : [];
}
