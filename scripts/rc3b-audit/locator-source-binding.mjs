/**
 * RC-3B-P0B -- same-buffer locator source binding. PURE.
 *
 * The brand and its minting primitive are module-private. Callers can request
 * verification, but cannot manufacture a SourceBoundLocatorResult.
 */

import { createHash } from 'crypto';
import { canonicalScalarBytes, inspectLocatorJson } from './locator-extract.mjs';

const SOURCE_BOUND = new WeakSet();

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

function mint(data) {
    const result = Object.freeze({ ...data });
    SOURCE_BOUND.add(result);
    return result;
}

export function isSourceBoundLocatorResult(value) { return !!value && SOURCE_BOUND.has(value); }

export function assertSourceBoundLocatorResult(value) {
    if (!isSourceBoundLocatorResult(value)) throw new TypeError('UNBOUND_ROWS_REJECTED');
    return value;
}

/**
 * Independently reparse and re-extract every admitted value from rawBuffer.
 * rawBuffer is not retained in, or returned from, the branded result.
 */
export function verifySourceBinding(rawBuffer, extraction, specs, source) {
    if (!Buffer.isBuffer(rawBuffer)) throw new TypeError('LOCATOR_SOURCE_MISMATCH');
    const getLength = source?.get_content_length;
    const headLength = source?.head_content_length;
    if (getLength != null && getLength !== rawBuffer.length) throw new Error('INTEGRITY_ANOMALY: GET ContentLength differs from collected Buffer length');
    if (headLength != null && headLength !== rawBuffer.length) throw new Error('INTEGRITY_ANOMALY: HEAD ContentLength differs from collected Buffer length');
    const getEtag = normalizeEtag(source?.get_etag);
    const headEtag = normalizeEtag(source?.head_etag);
    if (!getEtag) throw new Error('INTEGRITY_ANOMALY: GET ETag missing');
    if (headEtag && headEtag !== getEtag) throw new Error('INTEGRITY_ANOMALY: HEAD/GET ETag mismatch');

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
