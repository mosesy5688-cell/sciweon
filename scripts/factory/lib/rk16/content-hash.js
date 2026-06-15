/**
 * RK-16A2 — content-hash helpers (PURE MECHANISM, deterministic).
 *
 * The ONE place the substrate computes integrity hashes for canonical records
 * and projection rows. Both hash the CANONICAL bytes (canonicalize() from
 * snapshot-identity.js — sorted-key UTF-8 JSON, no whitespace) so the same
 * logical value always yields the same hash regardless of input key order.
 *
 * Substrate-only: no business policy, no I/O. OFFLINE/FIXTURE use only.
 */

import { createHash } from 'crypto';
import { canonicalize } from '../snapshot-identity.js';

/** SHA-256 (hex) over the canonical bytes of an arbitrary value. */
export function sha256Canonical(value) {
    return createHash('sha256')
        .update(Buffer.from(canonicalize(value), 'utf-8'))
        .digest('hex');
}

/** SHA-256 (hex) over raw bytes (Buffer/Uint8Array) — used for page payloads. */
export function sha256Bytes(bytes) {
    return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** content_hash for a canonical RECORD (binds a RecordLocator to its bytes). */
export function contentHash(record) {
    return sha256Canonical(record);
}

/** projection_hash for a projection ROW (binds the row to its derived bytes). */
export function projectionHash(row) {
    return sha256Canonical(row);
}
