/**
 * RC-3B-P0B -- same-buffer locator source binding. PURE.
 *
 * The brand and its minting primitive are module-private. Callers can request
 * verification, but cannot manufacture a SourceBoundLocatorResult.
 */

import { createHash } from 'crypto';
import { canonicalScalarBytes, inspectLocatorJson } from './locator-extract.mjs';

const SOURCE_BOUND = new WeakSet();
// Module-private integrity attestation: keyed by the branded root object, value
// is the canonical SHA-256 over the COMPLETE frozen source-bound payload. Brand
// membership proves a result came from mint; this digest proves the frozen graph
// is byte-for-byte the one that was minted. Neither is exported or forgeable.
const SOURCE_BOUND_DIGEST = new WeakMap();

function normalizeIndependent(value, rule) {
    if (rule === 'NONE') return value;
    if (typeof value !== 'string') throw new TypeError('LOCATOR_TYPE_MISMATCH');
    if (rule === 'TRIM') return value.trim();
    if (rule === 'ENSURE_TRAILING_SLASH') {
        const trimmed = value.trim();
        return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    }
    if (rule === 'LOWERCASE_HEX') return value.trim().toLowerCase();
    throw new TypeError('LOCATOR_VALUE_INVALID');
}

function normalizeEtag(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
}

/**
 * Recursively freeze the COMPLETE result graph BEFORE brand registration: the
 * root, every nested object, and every nested array (the arrays themselves, not
 * only their element objects).
 */
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

/**
 * Deterministic canonicalization (stable, sorted key ordering at every object
 * level; array order preserved) so the integrity digest is reproducible.
 */
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
        return out;
    }
    return value;
}

/** Canonical SHA-256 over the complete security-relevant source-bound payload. */
function integrityDigest(result) {
    return createHash('sha256').update(Buffer.from(JSON.stringify(canonicalize(result)), 'utf-8')).digest('hex');
}

function mint(data) {
    // Immutable BEFORE brand registration, then bind the canonical integrity
    // digest to the frozen root.
    const result = deepFreeze({ ...data });
    SOURCE_BOUND.add(result);
    SOURCE_BOUND_DIGEST.set(result, integrityDigest(result));
    return result;
}

export function isSourceBoundLocatorResult(value) { return !!value && SOURCE_BOUND.has(value); }

export function assertSourceBoundLocatorResult(value) {
    if (!isSourceBoundLocatorResult(value)) throw new TypeError('UNBOUND_ROWS_REJECTED');
    // Brand membership is necessary but NOT sufficient: recompute the canonical
    // digest over the CURRENT graph and reject any drift from the minted digest.
    const expected = SOURCE_BOUND_DIGEST.get(value);
    if (expected == null || integrityDigest(value) !== expected) {
        throw new Error('SOURCE_BOUND_RESULT_MUTATED');
    }
    return value;
}

/**
 * Independently reparse and re-extract every admitted value from rawBuffer.
 * rawBuffer is not retained in, or returned from, the branded result.
 */
export function verifySourceBinding(rawBuffer, extraction, specs, source) {
    if (!Buffer.isBuffer(rawBuffer)) throw new TypeError('LOCATOR_SOURCE_MISMATCH');
    // B2 -- fail-CLOSED HEAD/GET consistency, enforced in isolation
    // (defense-in-depth). A missing field is NEVER "cannot compare, continue";
    // every missing or mismatched field is an INTEGRITY_ANOMALY.
    const getLength = source?.get_content_length;
    const headLength = source?.head_content_length;
    if (headLength == null) throw new Error('INTEGRITY_ANOMALY: HEAD ContentLength missing');
    if (getLength == null) throw new Error('INTEGRITY_ANOMALY: GET ContentLength missing');
    if (headLength !== getLength) throw new Error('INTEGRITY_ANOMALY: HEAD/GET ContentLength mismatch');
    if (getLength !== rawBuffer.length) throw new Error('INTEGRITY_ANOMALY: GET ContentLength differs from collected Buffer length');
    if (headLength !== rawBuffer.length) throw new Error('INTEGRITY_ANOMALY: HEAD ContentLength differs from collected Buffer length');
    const getEtag = normalizeEtag(source?.get_etag);
    const headEtag = normalizeEtag(source?.head_etag);
    if (!headEtag) throw new Error('INTEGRITY_ANOMALY: HEAD ETag missing');
    if (!getEtag) throw new Error('INTEGRITY_ANOMALY: GET ETag missing');
    if (headEtag !== getEtag) throw new Error('INTEGRITY_ANOMALY: HEAD/GET ETag mismatch');

    const sourceFields = {
        source_etag: source.get_etag,
        source_byte_length: rawBuffer.length,
        source_byte_sha256: createHash('sha256').update(rawBuffer).digest('hex'),
    };

    // A parse/layout/duplicate diagnostic is independently confirmed. It has no
    // admitted value, but is still an opaque result produced by the same-buffer
    // verification path.
    if (extraction.group_status !== 'PASS') {
        const independent = inspectLocatorJson(rawBuffer);
        if ((extraction.group_status === 'DUPLICATE_KEY' && independent.status !== 'DUPLICATE_KEY')
            || (extraction.group_status === 'PARSE_FAILED' && independent.status !== 'PARSE_FAILED')) {
            throw new Error('LOCATOR_SOURCE_MISMATCH');
        }
        return mint({ ...extraction, ...sourceFields, source_binding_status: 'PASS' });
    }

    const inspected = inspectLocatorJson(rawBuffer);
    const specById = new Map(specs.map((s) => [s.spec_id, s]));
    let mismatch = inspected.status !== 'PASS';
    if (!mismatch) {
        for (const row of extraction.resolved) {
            const spec = specById.get(row.spec_id);
            if (!spec || !Object.hasOwn(inspected.parsed, spec.field_path)) { mismatch = true; break; }
            let independent;
            try { independent = normalizeIndependent(inspected.parsed[spec.field_path], spec.normalization); }
            catch { mismatch = true; break; }
            let a; let b;
            try {
                a = canonicalScalarBytes(independent, spec.scalar_type);
                b = canonicalScalarBytes(row.normalized_scalar_value, row.scalar_type);
            } catch { mismatch = true; break; }
            if (!a.equals(b)) { mismatch = true; break; }
        }
    }

    if (mismatch) {
        const unresolved = extraction.applicable_specs.filter((s) => s.required).map((s) => ({
            spec_id: s.spec_id, source_object_key: s.key, reason_code: 'LOCATOR_SOURCE_MISMATCH',
        }));
        return mint({
            ...extraction, ...sourceFields, resolved: [], unresolved,
            optional_absent_spec_ids: [], source_binding_status: 'FAILED',
        });
    }

    const resolved = extraction.resolved.map((row) => Object.freeze({ ...row, ...sourceFields }));
    return mint({ ...extraction, ...sourceFields, resolved, source_binding_status: 'PASS' });
}
