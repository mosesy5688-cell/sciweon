/**
 * NegEvidence bucket-hash SSoT — shared by the Node factory (publisher) and
 * the Cloudflare Worker bundle (loader). Plain `.js` ESM with a `.d.ts`
 * companion, mirroring src/lib/schemas/neg-evidence-types.js: both runtimes
 * import this exact module so the producer and the reader can NEVER disagree
 * on which bucket a key lands in.
 *
 * Why a parity gate guards this file (tests/factory/neg-bucket-hash-parity.test.ts):
 * the SAFETY endpoint (/compound/:id/negative-evidence) reads ONLY the bucket
 * computed from negBucketOf(key). If this hash ever drifts, the worker would
 * load the WRONG bucket's manifest, find no entry, and return an authoritative
 * `negative_signals_count: 0` — a FALSE-CLEAN on the highest-stakes endpoint.
 * Frozen golden vectors lock the hash so any change is caught in CI.
 *
 * The routing KEY is the full namespaced STRING (compound_id / trial_id /
 * bioactivity_id / paper_id / target_id), NOT a numeric CID — paper_retraction
 * orphans carry only paper_id, and the worker's compound endpoint resolves a
 * `sciweon::compound::CID:<n>` canonical string. We hash that string.
 */

export const NEG_BUCKET_COUNT = 1024;

/**
 * negKeyOf — derive the routing key for a NegEvidence record. The record's
 * subject identity lives under `record.subject.{compound_id,...}` (per the
 * neg-evidence schema); we also accept top-level fields as a defensive
 * fallback for any forward-/legacy-shaped record. NEVER returns null: a
 * record with no subject key still routes via a deterministic orphan key
 * derived from its `id` (PRESERVE-ALL — the partition is a permutation, no
 * record is ever dropped at routing time).
 *
 * Fallback chain (first non-empty wins):
 *   compound_id -> trial_id -> bioactivity_id -> paper_id -> target_id
 *   -> 'sciweon::neg::orphan::' + id
 */
export function negKeyOf(record) {
    const s = (record && typeof record === 'object' && record.subject) || {};
    const pick = (...vals) => {
        for (const v of vals) {
            if (typeof v === 'string' && v.length > 0) return v;
        }
        return null;
    };
    const key =
        pick(s.compound_id, record && record.compound_id) ||
        pick(s.trial_id, record && record.trial_id) ||
        pick(s.bioactivity_id, record && record.bioactivity_id) ||
        pick(s.paper_id, record && record.paper_id) ||
        pick(s.target_id, record && record.target_id);
    if (key) return key;
    const id = record && typeof record.id === 'string' ? record.id : '';
    return `sciweon::neg::orphan::${id}`;
}

/**
 * fnv1a32 — FNV-1a 32-bit hash over the UTF-8 bytes of `str`. Returned as an
 * unsigned 32-bit integer (>>> 0). Pure + dependency-free so both runtimes
 * compute byte-identical values.
 */
export function fnv1a32(str) {
    let hash = 0x811c9dc5; // FNV offset basis
    const bytes = utf8Bytes(str);
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        // hash *= 16777619 (FNV prime), kept in 32-bit range via Math.imul
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * utf8Bytes — encode a string to its UTF-8 byte array. Uses TextEncoder when
 * present (Worker + modern Node), with a manual fallback so the hash is
 * runtime-independent.
 */
function utf8Bytes(str) {
    const s = typeof str === 'string' ? str : String(str);
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(s);
    }
    const out = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) {
            out.push(c);
        } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const c2 = s.charCodeAt(i + 1);
            c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            i++;
            out.push(
                0xf0 | (c >> 18),
                0x80 | ((c >> 12) & 0x3f),
                0x80 | ((c >> 6) & 0x3f),
                0x80 | (c & 0x3f),
            );
        } else {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return out;
}

/**
 * negBucketOf — map a routing key string to a bucket index in
 * [0, NEG_BUCKET_COUNT). Stable, deterministic, parity-gated.
 */
export function negBucketOf(key) {
    return fnv1a32(key) % NEG_BUCKET_COUNT;
}
