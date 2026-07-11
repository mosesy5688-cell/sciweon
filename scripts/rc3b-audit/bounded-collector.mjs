/**
 * RC-3B-P0B -- bounded response-body collector (fail-before-overrun).
 *
 * A read-only client must NEVER buffer an unbounded response body: a provider
 * that ignores Range (returning a full object) or over-reports a small object
 * could otherwise blow memory or smuggle payload bytes into evidence. collectBounded
 * reads the body INCREMENTALLY and aborts the instant the running total would
 * exceed the caller's byte limit (i.e. reaches limitBytes + 1), throwing
 * ResponseBoundExceeded WITHOUT buffering or returning the overrun. On normal
 * completion it returns a Buffer whose length is <= limitBytes.
 *
 * Also provides a Content-Range parse/verify helper: a Range read must carry an
 * EXACT `bytes <offset>-<end>/<total>` header (start/end match; total any int)
 * before its body is parsed or hashed into evidence.
 */

export class ResponseBoundExceeded extends Error {}

/**
 * @param {*} body        async-iterable / Buffer / Uint8Array / string / null
 * @param {number} limitBytes  hard ceiling; reaching limitBytes+1 aborts
 * @returns {Promise<Buffer>} length <= limitBytes
 */
export async function collectBounded(body, limitBytes) {
    const limit = Number(limitBytes);
    if (body == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
        const buf = Buffer.isBuffer(body)
            ? body
            : (typeof body === 'string' ? Buffer.from(body, 'utf-8') : Buffer.from(body));
        if (buf.length > limit) {
            throw new ResponseBoundExceeded(`response body ${buf.length} exceeds limit ${limit}`);
        }
        return buf;
    }
    // Async-iterable stream: accumulate, aborting the moment we cross the limit.
    const chunks = [];
    let total = 0;
    for await (const c of body) {
        const chunk = typeof c === 'string' ? Buffer.from(c, 'utf-8') : Buffer.from(c);
        total += chunk.length;
        if (total > limit) {
            throw new ResponseBoundExceeded(`response body exceeded limit ${limit} at ${total} bytes -- aborting`);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/** The exact Content-Range VALUE prefix a bounded range read must carry. */
export function expectedContentRangePrefix(offset, length) {
    return `bytes ${offset}-${offset + length - 1}/`;
}

/**
 * True only when `contentRange` is exactly `bytes <offset>-<end>/<total>` with
 * start === offset, end === offset+length-1, and an integer total.
 */
export function verifyContentRange(contentRange, offset, length) {
    if (typeof contentRange !== 'string') return false;
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!m) return false;
    return Number(m[1]) === offset && Number(m[2]) === offset + length - 1;
}
