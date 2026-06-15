/**
 * RK-16A2 — reader-side canonical hashing (PURE MECHANISM).
 *
 * Byte-identical re-implementation of the producer's canonicalize() +
 * sha256-hex (scripts/factory/lib/snapshot-identity.js): deterministic JSON with
 * keys sorted recursively (arrays keep order), UTF-8, no whitespace, compact
 * separators. The producer is Node (createHash); the worker has no Node crypto,
 * so this uses Web Crypto (crypto.subtle.digest) — hence ASYNC. A round-trip
 * test locks producer-hash === reader-hash.
 *
 * Used to verify a read canonical record matches its RecordLocator.content_hash.
 */

/** Deterministic canonical bytes for a value (matches the producer exactly). */
export function canonicalize(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        const body = keys
            .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
            .join(',');
        return `{${body}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function toHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

/** SHA-256 (hex) over the canonical bytes of a value (Web Crypto, async). */
export async function sha256Canonical(value: unknown): Promise<string> {
    const data = new TextEncoder().encode(canonicalize(value));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return toHex(digest);
}

/** SHA-256 (hex) over raw bytes (Web Crypto, async). For page/directory payloads. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return toHex(digest);
}
