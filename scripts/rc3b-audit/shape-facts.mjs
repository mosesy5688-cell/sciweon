/**
 * RC-3B-P0B -- structural shape facts (PURE, no network).
 *
 * The read primitives return ONLY these facts about the bytes they observe --
 * never the bytes themselves and never any value copied out of the payload. A
 * "shape signature" is a hash of the STRUCTURE (sorted property-name skeleton +
 * type tags), so two objects with the same shape but different values collide,
 * and no field value can be reconstructed from it. This is what makes the
 * evidence builder structurally unable to emit body-derived free text.
 */

import { createHash } from 'crypto';

export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

export async function streamToBuffer(body) {
    if (body == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    const chunks = [];
    for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
}

/**
 * Build a value-free skeleton of a parsed JSON value: object -> sorted property
 * names each mapped to their child's skeleton; array -> the skeleton of its
 * first element wrapped once (length-independent); scalars -> a bare type tag.
 * No scalar VALUE is ever included.
 */
export function shapeSkeleton(value) {
    if (Array.isArray(value)) {
        return { '[]': value.length ? shapeSkeleton(value[0]) : 'empty' };
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = shapeSkeleton(value[k]);
        return out;
    }
    return typeof value; // 'string' | 'number' | 'boolean' | ... -- NO value
}

/**
 * Structural facts for a JSON-ish object body: its byte length, a hash of the
 * raw bytes (integrity only), the SORTED top-level property NAMES, and a shape
 * signature hash. If the bytes are not JSON, only length + byte-hash are set.
 */
export function structuralFacts(buf) {
    const facts = {
        byte_length: buf.length,
        byte_sha256: sha256Hex(buf),
        parseable_json: false,
        top_level_property_names: [],
        shape_signature_sha256: null,
    };
    let parsed;
    try { parsed = JSON.parse(buf.toString('utf-8')); }
    catch { return facts; }
    facts.parseable_json = true;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        facts.top_level_property_names = Object.keys(parsed).sort();
    }
    const skel = JSON.stringify(shapeSkeleton(parsed));
    facts.shape_signature_sha256 = sha256Hex(Buffer.from(skel, 'utf-8'));
    return facts;
}

/**
 * Facts for a raw byte sample (a locator-bound range): length + byte-hash +
 * a shape signature over the leading magic bytes only (structure, not content).
 * `decodedBytesCap` bounds how many bytes may be inspected as a sample.
 */
export function sampleFacts(buf, decodedBytesCap) {
    const inspected = Math.min(buf.length, decodedBytesCap);
    const head = buf.subarray(0, Math.min(inspected, 16));
    return {
        sample_bytes_read: buf.length,
        sample_decoded_bytes: inspected,
        shape_signature_sha256: sha256Hex(head),
    };
}
