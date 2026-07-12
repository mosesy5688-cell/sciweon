/**
 * RC-3B-P0B -- committed structural-locator extraction policy. PURE.
 *
 * GET_LOCATOR is deliberately narrower than generic JSON extraction: exact
 * top-level fields, committed patterns, bounded scalar values, and committed
 * cross-field rules only. Rejected raw values are never returned.
 */

import { createHash } from 'crypto';

export const LOCATOR_SEMANTIC_TYPES = Object.freeze([
    'LAYOUT_VERSION', 'SNAPSHOT_ID', 'OBJECT_PREFIX', 'MANIFEST_KEY',
    'OBJECT_KEY', 'RELEASE_TOKEN', 'SNAPSHOT_DATE', 'SHA256_HEX', 'RECORD_COUNT',
]);
export const LOCATOR_SCALAR_TYPES = Object.freeze(['string', 'integer']);
export const LOCATOR_POINTER_SHAPES = Object.freeze(['immutable_snapshot_v2', 'legacy_v1', 'cursor_v1']);
export const LOCATOR_NORMALIZATIONS = Object.freeze(['NONE', 'TRIM', 'ENSURE_TRAILING_SLASH', 'LOWERCASE_HEX']);

const RX = Object.freeze({
    OBJECT_PREFIX_V2: /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)snapshots\/[0-9A-Za-z._/-]+\/$/,
    MANIFEST_KEY_PATHSAFE: /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)snapshots\/[0-9A-Za-z._/-]+$/,
    R2_DATA_KEY_PATHSAFE: /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!\/)[0-9A-Za-z._/-]{1,256}$/,
    RELEASE_TOKEN_SEGMENT: /^(?!\.?\.?$)(?!.*\.\.)[0-9A-Za-z._-]{1,64}$/,
    ISO_DATE: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
    SHA256_HEX: /^[0-9a-f]{64}$/,
});

/** The regex text is committed here; runtime input supplies identifiers only. */
export const LOCATOR_PATTERNS = Object.freeze({
    LAYOUT_VERSION_V2: Object.freeze({ kind: 'string', test: (v) => v === 'immutable_snapshot_v2' }),
    SNAPSHOT_ID_V2: Object.freeze({ kind: 'string', test: isSnapshotIdV2 }),
    OBJECT_PREFIX_V2: Object.freeze({ kind: 'string', test: (v) => RX.OBJECT_PREFIX_V2.test(v) && safePathSegments(v, { allowTrailingSlash: true }).ok }),
    MANIFEST_KEY_PATHSAFE: Object.freeze({ kind: 'string', test: (v) => RX.MANIFEST_KEY_PATHSAFE.test(v) && safePathSegments(v).ok }),
    R2_DATA_KEY_PATHSAFE: Object.freeze({ kind: 'string', test: (v) => RX.R2_DATA_KEY_PATHSAFE.test(v) && safePathSegments(v).ok }),
    RELEASE_TOKEN_SEGMENT: Object.freeze({ kind: 'string', test: (v) => RX.RELEASE_TOKEN_SEGMENT.test(v) && safeSingleSegment(v) }),
    ISO_DATE: Object.freeze({ kind: 'string', test: isRealIsoDate }),
    SHA256_HEX: Object.freeze({ kind: 'string', test: (v) => RX.SHA256_HEX.test(v) }),
    NONNEG_INTEGER: Object.freeze({ kind: 'integer', test: (v) => Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0 }),
});

export const CROSS_FIELD_RULE_IDS = Object.freeze([
    'OBJECT_PREFIX_EQUALS_SNAPSHOTS_PLUS_ID',
    'OBJECT_PREFIX_STARTS_SNAPSHOTS_ENDS_SLASH',
    'PATH_SEGMENTS_SAFE',
    'SNAPSHOT_ID_MATCHES_IMMUTABLE_IDENTITY',
    'MANIFEST_KEY_UNDER_OBJECT_PREFIX',
    'COMPOUNDS_MANIFEST_EQUALS_FIXED_SUFFIX',
    'UMLS_MESH_KEY_EQUALS_RELEASE_PATH',
    'UMLS_SNOMED_KEY_EQUALS_RELEASE_PATH',
    'UMLS_LOINC_KEY_EQUALS_RELEASE_PATH',
    'FDA_SRS_KEY_EQUALS_RELEASE_DATE_PATH',
    'RELEASE_TOKEN_SINGLE_SEGMENT',
    'LAYOUT_SELECTS_SPEC_SET',
]);

const DEPENDENCIES = Object.freeze({
    OBJECT_PREFIX_EQUALS_SNAPSHOTS_PLUS_ID: ['snapshot_id'],
    SNAPSHOT_ID_MATCHES_IMMUTABLE_IDENTITY: ['snapshot_date'],
    MANIFEST_KEY_UNDER_OBJECT_PREFIX: ['object_prefix'],
    COMPOUNDS_MANIFEST_EQUALS_FIXED_SUFFIX: ['object_prefix'],
    UMLS_MESH_KEY_EQUALS_RELEASE_PATH: ['release'],
    UMLS_SNOMED_KEY_EQUALS_RELEASE_PATH: ['release'],
    UMLS_LOINC_KEY_EQUALS_RELEASE_PATH: ['release'],
    FDA_SRS_KEY_EQUALS_RELEASE_DATE_PATH: ['release_date'],
});

function candidate(candidates, name) { return candidates instanceof Map ? candidates.get(name) : candidates?.[name]; }

export const CROSS_FIELD_RULES = Object.freeze({
    OBJECT_PREFIX_EQUALS_SNAPSHOTS_PLUS_ID: (v, c) => v === `snapshots/${candidate(c, 'snapshot_id')}/`,
    OBJECT_PREFIX_STARTS_SNAPSHOTS_ENDS_SLASH: (v) => typeof v === 'string' && v.startsWith('snapshots/') && v.endsWith('/'),
    PATH_SEGMENTS_SAFE: (v, _c, spec) => safePathSegments(v, { allowTrailingSlash: spec.semantic_type === 'OBJECT_PREFIX' }).ok,
    SNAPSHOT_ID_MATCHES_IMMUTABLE_IDENTITY: (v, c) => typeof v === 'string' && v.split('/')[0] === candidate(c, 'snapshot_date'),
    MANIFEST_KEY_UNDER_OBJECT_PREFIX: (v, c) => typeof v === 'string' && v.startsWith(candidate(c, 'object_prefix') || '\0'),
    COMPOUNDS_MANIFEST_EQUALS_FIXED_SUFFIX: (v, c) => v === `${candidate(c, 'object_prefix')}compounds/bucket-0000/manifest.json`,
    UMLS_MESH_KEY_EQUALS_RELEASE_PATH: (v, c) => v === `internal/processed/bulk/umls/${candidate(c, 'release')}/mesh-concepts.jsonl.zst`,
    UMLS_SNOMED_KEY_EQUALS_RELEASE_PATH: (v, c) => v === `internal/processed/bulk/umls/${candidate(c, 'release')}/snomed-concepts.jsonl.zst`,
    UMLS_LOINC_KEY_EQUALS_RELEASE_PATH: (v, c) => v === `internal/processed/bulk/umls/${candidate(c, 'release')}/loinc-concepts.jsonl.zst`,
    FDA_SRS_KEY_EQUALS_RELEASE_DATE_PATH: (v, c) => v === `processed/bulk/fda-srs/${candidate(c, 'release_date')}/unii-lookup.jsonl.zst`,
    RELEASE_TOKEN_SINGLE_SEGMENT: (v) => safeSingleSegment(v),
    LAYOUT_SELECTS_SPEC_SET: () => true,
});

function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }

export function canonicalScalarBytes(value, scalarType) {
    if (scalarType === 'string') {
        if (typeof value !== 'string') throw new TypeError('LOCATOR_TYPE_MISMATCH');
        return Buffer.from(value, 'utf-8');
    }
    if (scalarType === 'integer') {
        if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('LOCATOR_TYPE_MISMATCH');
        return Buffer.from(String(value), 'utf-8');
    }
    throw new TypeError('LOCATOR_TYPE_MISMATCH');
}

export function normalizeLocatorValue(value, normalization) {
    if (normalization === 'NONE') return value;
    if (typeof value !== 'string') throw new TypeError('LOCATOR_TYPE_MISMATCH');
    if (normalization === 'TRIM') return value.trim();
    if (normalization === 'ENSURE_TRAILING_SLASH') {
        const v = value.trim();
        return v.endsWith('/') ? v : `${v}/`;
    }
    if (normalization === 'LOWERCASE_HEX') return value.trim().toLowerCase();
    throw new TypeError('LOCATOR_VALUE_INVALID');
}

export function safePathSegments(value, { allowTrailingSlash = false } = {}) {
    if (typeof value !== 'string') return { ok: false, reason: 'not-string' };
    if (!value || value !== value.trim()) return { ok: false, reason: 'whitespace' };
    if (value.startsWith('/')) return { ok: false, reason: 'leading-slash' };
    if (value.includes('\\')) return { ok: false, reason: 'backslash' };
    if (/[\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: 'control' };
    const parts = value.split('/');
    for (let i = 0; i < parts.length; i += 1) {
        const p = parts[i];
        if (p === '' && allowTrailingSlash && i === parts.length - 1) continue;
        if (p === '' || p === '.' || p === '..') return { ok: false, reason: 'unsafe-segment' };
    }
    return { ok: true, reason: 'PASS' };
}

function safeSingleSegment(value) {
    return typeof value === 'string'
        && !value.includes('/') && !value.includes('\\') && !/[\x00-\x20\x7f]/.test(value)
        && value !== '.' && value !== '..' && !value.includes('..');
}

export function isRealIsoDate(value) {
    if (typeof value !== 'string' || !RX.ISO_DATE.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isSnapshotIdV2(value) {
    if (typeof value !== 'string') return false;
    const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})\/((?:[0-9]+)|(?:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}))-([1-9][0-9]*)$/.exec(value);
    return !!m && isRealIsoDate(m[1]);
}

function canonicalRule(rule) {
    return {
        field_path: rule.field_path,
        semantic_type: rule.semantic_type,
        scalar_type: rule.scalar_type,
        value_pattern_id: rule.value_pattern_id,
        normalization: rule.normalization,
        max_utf8_bytes: rule.max_utf8_bytes,
        required: rule.required,
        pointer_shape: rule.pointer_shape,
        cross_field_rules: [...(rule.cross_field_rules || [])].sort(),
    };
}

export function canonicalLocatorSpecs(specs = []) {
    return [...specs].map((s) => ({ spec_id: s.spec_id, key: s.key, ...canonicalRule(s) }))
        .sort((a, b) => a.spec_id.localeCompare(b.spec_id));
}

export function canonicalLocatorRules(rules = []) {
    return [...rules].map(canonicalRule)
        .sort((a, b) => `${a.pointer_shape}|${a.field_path}`.localeCompare(`${b.pointer_shape}|${b.field_path}`));
}

export function validateLocatorSpecShape(spec) {
    const errors = [];
    const fields = ['spec_id', 'key', 'field_path', 'semantic_type', 'value_pattern_id', 'scalar_type', 'max_utf8_bytes', 'required', 'pointer_shape', 'normalization', 'cross_field_rules'];
    const extras = Object.keys(spec || {}).filter((k) => !fields.includes(k));
    if (extras.length) errors.push(`unexpected fields: ${extras.join(',')}`);
    if (!/^[A-Z0-9_]{3,64}$/.test(spec?.spec_id || '')) errors.push('invalid spec_id');
    if (typeof spec?.key !== 'string' || !spec.key || spec.key.length > 256) errors.push('invalid key');
    if (!/^[A-Za-z0-9_]{1,64}$/.test(spec?.field_path || '') || ['__proto__', 'constructor', 'prototype', 'hasOwnProperty'].includes(spec?.field_path)) errors.push('invalid field_path');
    if (!LOCATOR_SEMANTIC_TYPES.includes(spec?.semantic_type)) errors.push('invalid semantic_type');
    if (!Object.hasOwn(LOCATOR_PATTERNS, spec?.value_pattern_id)) errors.push('invalid value_pattern_id');
    if (!LOCATOR_SCALAR_TYPES.includes(spec?.scalar_type)) errors.push('invalid scalar_type');
    if (!Number.isInteger(spec?.max_utf8_bytes) || spec.max_utf8_bytes < 1 || spec.max_utf8_bytes > 512) errors.push('invalid max_utf8_bytes');
    if (typeof spec?.required !== 'boolean') errors.push('invalid required');
    if (!LOCATOR_POINTER_SHAPES.includes(spec?.pointer_shape)) errors.push('invalid pointer_shape');
    if (!LOCATOR_NORMALIZATIONS.includes(spec?.normalization)) errors.push('invalid normalization');
    if (!Array.isArray(spec?.cross_field_rules)) errors.push('invalid cross_field_rules');
    else {
        if (new Set(spec.cross_field_rules).size !== spec.cross_field_rules.length) errors.push('duplicate cross_field_rules');
        for (const id of spec.cross_field_rules) if (!CROSS_FIELD_RULE_IDS.includes(id)) errors.push(`unknown cross_field_rule ${id}`);
    }
    return errors;
}

export function validateLocatorSpecAgainstRule(spec, rule) {
    const errors = validateLocatorSpecShape(spec);
    for (const f of ['field_path', 'semantic_type', 'scalar_type', 'value_pattern_id', 'normalization', 'pointer_shape']) {
        if (spec?.[f] !== rule?.[f]) errors.push(`${f} must equal template rule`);
    }
    if (!Number.isInteger(rule?.max_utf8_bytes) || spec?.max_utf8_bytes > rule.max_utf8_bytes) errors.push('max_utf8_bytes widens template rule');
    if (rule?.required === true && spec?.required !== true) errors.push('required template rule cannot be downgraded');
    const sr = spec?.cross_field_rules || [];
    for (const id of rule?.cross_field_rules || []) if (!sr.includes(id)) errors.push(`cross_field_rules drops ${id}`);
    return errors;
}

function decodeJsonString(text, start) {
    let out = ''; let i = start + 1;
    while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === 0x22) return { value: out, end: i + 1 };
        if (c < 0x20) throw new SyntaxError('invalid control in JSON string');
        if (c === 0x5c) {
            i += 1;
            const e = text[i];
            const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (Object.hasOwn(simple, e)) { out += simple[e]; i += 1; continue; }
            if (e !== 'u' || !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) throw new SyntaxError('invalid JSON escape');
            const unit = Number.parseInt(text.slice(i + 1, i + 5), 16); i += 5;
            if (unit >= 0xd800 && unit <= 0xdbff) {
                if (text.slice(i, i + 2) !== '\\u' || !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) throw new SyntaxError('unpaired high surrogate');
                const low = Number.parseInt(text.slice(i + 2, i + 6), 16);
                if (low < 0xdc00 || low > 0xdfff) throw new SyntaxError('unpaired high surrogate');
                out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)); i += 6; continue;
            }
            if (unit >= 0xdc00 && unit <= 0xdfff) throw new SyntaxError('unpaired low surrogate');
            out += String.fromCharCode(unit); continue;
        }
        if (c >= 0xd800 && c <= 0xdfff) {
            if (c > 0xdbff || i + 1 >= text.length) throw new SyntaxError('unpaired surrogate');
            const low = text.charCodeAt(i + 1);
            if (low < 0xdc00 || low > 0xdfff) throw new SyntaxError('unpaired surrogate');
            out += text[i] + text[i + 1]; i += 2; continue;
        }
        out += text[i]; i += 1;
    }
    throw new SyntaxError('unterminated JSON string');
}

/** Scan decoded top-level object keys before JSON.parse last-wins can occur. */
export function scanTopLevelJsonKeys(raw) {
    const text = Buffer.isBuffer(raw) || raw instanceof Uint8Array
        ? new TextDecoder('utf-8', { fatal: true }).decode(raw)
        : String(raw);
    const seen = new Set(); let depth = 0; let rootSeen = false; let expectingKey = false;
    for (let i = 0; i < text.length;) {
        const ch = text[i];
        if (/\s/.test(ch)) { i += 1; continue; }
        if (ch === '"') {
            const s = decodeJsonString(text, i);
            if (depth === 1 && expectingKey) {
                if (seen.has(s.value)) return { ok: false, duplicate: s.value, text };
                seen.add(s.value); expectingKey = false;
            }
            i = s.end; continue;
        }
        if (ch === '{' || ch === '[') {
            depth += 1;
            if (!rootSeen) { if (ch !== '{') throw new SyntaxError('locator JSON root must be an object'); rootSeen = true; expectingKey = true; }
            i += 1; continue;
        }
        if (ch === '}' || ch === ']') { depth -= 1; if (depth < 0) throw new SyntaxError('invalid JSON nesting'); i += 1; continue; }
        if (ch === ',' && depth === 1) expectingKey = true;
        i += 1;
    }
    return { ok: true, keys: [...seen], text };
}

function inspect(raw) {
    let scan;
    try { scan = scanTopLevelJsonKeys(raw); } catch { return { status: 'PARSE_FAILED', parsed: null }; }
    if (!scan.ok) return { status: 'DUPLICATE_KEY', parsed: null };
    try {
        const parsed = JSON.parse(scan.text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'PARSE_FAILED', parsed: null };
        return { status: 'PASS', parsed };
    } catch { return { status: 'PARSE_FAILED', parsed: null }; }
}

export function inspectLocatorJson(raw) { return inspect(raw); }

function selectShape(parsed, specs) {
    const shapes = new Set(specs.map((s) => s.pointer_shape));
    if (shapes.size === 1 && shapes.has('cursor_v1')) return { ok: true, shape: 'cursor_v1' };
    const v2Fields = new Set(specs.filter((s) => s.pointer_shape === 'immutable_snapshot_v2').map((s) => s.field_path));
    const legacyFields = new Set(specs.filter((s) => s.pointer_shape === 'legacy_v1').map((s) => s.field_path));
    const hasV2 = [...v2Fields].some((f) => Object.hasOwn(parsed, f));
    const hasLegacy = [...legacyFields].some((f) => Object.hasOwn(parsed, f));
    if (parsed.layout_version === 'immutable_snapshot_v2' && !hasLegacy) return { ok: true, shape: 'immutable_snapshot_v2' };
    if (!Object.hasOwn(parsed, 'layout_version') && hasLegacy && !hasV2) return { ok: true, shape: 'legacy_v1' };
    return { ok: false, shape: null };
}

function unresolvedFor(specs, reason) {
    return specs.filter((s) => s.required).map((s) => ({ spec_id: s.spec_id, source_object_key: s.key, reason_code: reason }));
}

function phaseOne(parsed, specs) {
    const passed = []; const failed = [];
    for (const spec of specs) {
        let reason = null; let normalized;
        if (!Object.hasOwn(parsed, spec.field_path)) reason = 'LOCATOR_FIELD_ABSENT';
        else {
            const raw = parsed[spec.field_path];
            const segmentPattern = ['OBJECT_PREFIX_V2', 'MANIFEST_KEY_PATHSAFE', 'R2_DATA_KEY_PATHSAFE', 'RELEASE_TOKEN_SEGMENT'].includes(spec.value_pattern_id);
            if (segmentPattern && typeof raw === 'string' && raw !== raw.trim()) reason = 'LOCATOR_SEGMENT_INVALID';
            try { normalized = normalizeLocatorValue(raw, spec.normalization); } catch { reason = 'LOCATOR_TYPE_MISMATCH'; }
            if (!reason && (spec.scalar_type === 'string' ? typeof normalized !== 'string' : !Number.isSafeInteger(normalized) || Object.is(normalized, -0))) reason = 'LOCATOR_TYPE_MISMATCH';
            let bytes;
            if (!reason) {
                try { bytes = canonicalScalarBytes(normalized, spec.scalar_type); } catch { reason = 'LOCATOR_TYPE_MISMATCH'; }
            }
            if (!reason && bytes.length > spec.max_utf8_bytes) reason = 'LOCATOR_OVERLENGTH';
            if (!reason && ['OBJECT_PREFIX_V2', 'MANIFEST_KEY_PATHSAFE', 'R2_DATA_KEY_PATHSAFE'].includes(spec.value_pattern_id)) {
                const seg = safePathSegments(normalized, { allowTrailingSlash: spec.value_pattern_id === 'OBJECT_PREFIX_V2' });
                if (!seg.ok) reason = 'LOCATOR_SEGMENT_INVALID';
            }
            if (!reason && spec.value_pattern_id === 'RELEASE_TOKEN_SEGMENT' && !safeSingleSegment(normalized)) reason = 'LOCATOR_SEGMENT_INVALID';
            const pat = LOCATOR_PATTERNS[spec.value_pattern_id];
            if (!reason && (!pat || !pat.test(normalized))) reason = 'LOCATOR_VALUE_INVALID';
            if (!reason) passed.push({ spec, value: normalized, bytes });
        }
        if (reason) failed.push({ spec, reason });
    }
    return { passed, failed };
}

export function evaluateCrossFieldTwoPhase(specs, phase1PassSet, candidateMap) {
    const resolved = []; const unresolved = [];
    const passById = phase1PassSet instanceof Map ? phase1PassSet : new Map(phase1PassSet.map((x) => [x.spec.spec_id, x]));
    for (const spec of specs) {
        const row = passById.get(spec.spec_id);
        if (!row) continue;
        let reason = null;
        for (const id of spec.cross_field_rules || []) {
            const deps = DEPENDENCIES[id] || [];
            if (deps.some((f) => !candidateMap.has(f))) { reason = 'LOCATOR_DEPENDENCY_INVALID'; break; }
            const fn = CROSS_FIELD_RULES[id];
            if (!fn || !fn(row.value, candidateMap, spec)) { reason = 'LOCATOR_CROSS_FIELD_FAIL'; break; }
        }
        if (reason) unresolved.push({ spec, reason }); else resolved.push(row);
    }
    return { resolved, unresolved };
}

/** Extract only admitted scalars; raw rejected values never leave this function. */
export function extractLocators(raw, specs, _ctx = {}) {
    const ordered = [...specs];
    const inspected = inspect(raw);
    if (inspected.status === 'DUPLICATE_KEY') {
        return groupFailure(ordered, 'DUPLICATE_KEY', 'LOCATOR_JSON_DUPLICATE_KEY');
    }
    if (inspected.status !== 'PASS') return groupFailure(ordered, 'PARSE_FAILED', 'LOCATOR_VALUE_INVALID');
    const selected = selectShape(inspected.parsed, ordered);
    if (!selected.ok) return groupFailure(ordered, 'LAYOUT_INVALID', 'LOCATOR_LAYOUT_INVALID');
    const applicable = ordered.filter((s) => s.pointer_shape === selected.shape);
    const p1 = phaseOne(inspected.parsed, applicable);
    const candidates = new Map(p1.passed.map((x) => [x.spec.field_path, x.value]));
    const p2 = evaluateCrossFieldTwoPhase(applicable, p1.passed, candidates);
    const failed = [...p1.failed, ...p2.unresolved];
    const resolved = p2.resolved.map(({ spec, value, bytes }) => ({
        spec_id: spec.spec_id, semantic_type: spec.semantic_type, source_object_key: spec.key,
        field_path: spec.field_path, pointer_shape: spec.pointer_shape, scalar_type: spec.scalar_type,
        admitted: true, value_utf8_bytes: bytes.length, value_sha256: sha256Hex(bytes), normalized_scalar_value: value,
    }));
    const unresolved = failed.filter(({ spec }) => spec.required).map(({ spec, reason }) => ({
        spec_id: spec.spec_id, source_object_key: spec.key, reason_code: reason,
    }));
    const optionalAbsent = failed.filter(({ spec }) => !spec.required).map(({ spec }) => spec.spec_id);
    return {
        source_object_key: applicable[0]?.key || ordered[0]?.key,
        applicability_status: 'RESOLVED', selected_pointer_shape: selected.shape, group_status: 'PASS',
        applicable_specs: applicable, resolved, unresolved, optional_absent_spec_ids: optionalAbsent,
    };
}

function groupFailure(specs, status, reason) {
    const cursor = specs.length > 0 && specs.every((s) => s.pointer_shape === 'cursor_v1');
    return {
        source_object_key: specs[0]?.key,
        applicability_status: cursor ? 'RESOLVED' : 'UNRESOLVED',
        selected_pointer_shape: cursor ? 'cursor_v1' : null, group_status: status,
        applicable_specs: specs, resolved: [], unresolved: unresolvedFor(specs, reason), optional_absent_spec_ids: [],
    };
}
