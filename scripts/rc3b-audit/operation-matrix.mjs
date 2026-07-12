/**
 * RC-3B-P0B -- CLASS-C operation/class matrix (CHANGE D; A8). PURE.
 *
 * Decides, purely from (operation, effectiveClass), whether a would-be typed
 * operation is even admissible BEFORE any network. It is a second, independent
 * gate on top of the per-key format policy + the template families: a payload
 * class (MONOLITHIC_GZIP / MONOLITHIC_ZSTD / PAYLOAD_JSONL) may ONLY be HEAD-ed;
 * a GET_META / RANGE / full GET of a payload class is DENIED (not seekable, no
 * arbitrary middle decode). STRUCTURAL_JSON is GET_META/GET_LOCATOR-only; NXVF_SHARD is
 * RANGE-only. Everything else default-denies.
 *
 * The effectiveClass MUST be derived from the key suffix / template, NEVER from a
 * free object_class_map override -- so an attacker cannot relabel a payload key
 * to slip it through a different operation.
 */

const PAYLOAD_CLASSES = Object.freeze(['MONOLITHIC_GZIP', 'MONOLITHIC_ZSTD', 'PAYLOAD_JSONL']);

/**
 * @param {{operation:string, effectiveClass:string}} arg
 * @returns {{allow:boolean, reason:string}}
 */
export function decideOperation({ operation, effectiveClass } = {}) {
    // STRUCTURAL_JSON: value-free GET_META or committed-scalar GET_LOCATOR only.
    if (effectiveClass === 'STRUCTURAL_JSON') {
        if (operation === 'GET_META' || operation === 'GET_LOCATOR') return { allow: true, reason: `STRUCTURAL_JSON ${operation}` };
        return { allow: false, reason: `STRUCTURAL_JSON supports only GET_META or GET_LOCATOR (got ${operation}) -- not seekable for ${operation}` };
    }

    // NXVF_SHARD: locator-bound RANGE only.
    if (effectiveClass === 'NXVF_SHARD') {
        if (operation === 'RANGE') return { allow: true, reason: 'NXVF_SHARD locator-bound RANGE' };
        return { allow: false, reason: `NXVF_SHARD supports only RANGE (got ${operation})` };
    }

    // Payload classes: HEAD only. GET_META / RANGE / GET are DENIED.
    if (PAYLOAD_CLASSES.includes(effectiveClass)) {
        if (operation === 'HEAD') return { allow: true, reason: `CLASS-C payload HEAD (${effectiveClass})` };
        return { allow: false, reason: `payload class ${effectiveClass} is not seekable -- ${operation} denied (HEAD only)` };
    }

    // Unknown / unhandled class -> default-deny.
    return { allow: false, reason: `unknown object class ${JSON.stringify(effectiveClass)} -- default-deny` };
}

export { PAYLOAD_CLASSES };
