// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    canonicalScalarBytes, extractLocators, safePathSegments, scanTopLevelJsonKeys,
    validateLocatorSpecAgainstRule,
} from '../../scripts/rc3b-audit/locator-extract.mjs';
import { syntheticLocatorSpecs, manifestBodyBuffer } from '../../scripts/rc3b-audit/self-test.mjs';

const specs = () => syntheticLocatorSpecs().map((s) => ({ ...s, cross_field_rules: [...s.cross_field_rules] }));
const body = (over = {}) => Buffer.from(JSON.stringify({
    layout_version: 'immutable_snapshot_v2', snapshot_date: '2026-01-01',
    snapshot_id: '2026-01-01/1-1', object_prefix: 'snapshots/2026-01-01/1-1/',
    compounds_manifest_key: 'snapshots/2026-01-01/1-1/compounds/bucket-0000/manifest.json',
    ...over,
}));

describe('GET_LOCATOR positives and canonical scalar bytes', () => {
    it('P1-P3 admits the synthetic v2 snapshot identity, prefix, and fixed manifest', () => {
        const r = extractLocators(manifestBodyBuffer(), specs());
        expect(r.group_status).toBe('PASS');
        expect(r.resolved).toHaveLength(5);
        expect(r.unresolved).toEqual([]);
    });

    it('CE5/N37 golden canonical bytes are unambiguous and boolean/-0 are rejected', () => {
        expect(canonicalScalarBytes('1', 'string').toString('hex')).toBe('31');
        expect(canonicalScalarBytes(1, 'integer').toString('hex')).toBe('31');
        expect(() => canonicalScalarBytes(-0, 'integer')).toThrow();
        expect(() => canonicalScalarBytes(true, 'boolean')).toThrow();
    });

    it('P4-P6 admits source-bound-form UMLS/FDA release/key pairs', () => {
        const cursor = (id, field, semantic, pattern, rules = []) => ({
            spec_id: id, key: 'synthetic/state/cursor.json', field_path: field,
            semantic_type: semantic, value_pattern_id: pattern, scalar_type: 'string',
            max_utf8_bytes: 256, required: true, pointer_shape: 'cursor_v1', normalization: 'NONE', cross_field_rules: rules,
        });
        const mesh = [cursor('MESH_RELEASE', 'release', 'RELEASE_TOKEN', 'RELEASE_TOKEN_SEGMENT', ['RELEASE_TOKEN_SINGLE_SEGMENT']), cursor('MESH_KEY', 'r2_data_key', 'OBJECT_KEY', 'R2_DATA_KEY_PATHSAFE', ['UMLS_MESH_KEY_EQUALS_RELEASE_PATH'])];
        expect(extractLocators(Buffer.from(JSON.stringify({ release: '2025AB', r2_data_key: 'internal/processed/bulk/umls/2025AB/mesh-concepts.jsonl.zst' })), mesh).resolved).toHaveLength(2);
        const fda = [cursor('FDA_RELEASE', 'release_date', 'RELEASE_TOKEN', 'RELEASE_TOKEN_SEGMENT', ['RELEASE_TOKEN_SINGLE_SEGMENT']), cursor('FDA_KEY', 'r2_data_key', 'OBJECT_KEY', 'R2_DATA_KEY_PATHSAFE', ['FDA_SRS_KEY_EQUALS_RELEASE_DATE_PATH'])];
        expect(extractLocators(Buffer.from(JSON.stringify({ release_date: '2026-05-01', r2_data_key: 'processed/bulk/fda-srs/2026-05-01/unii-lookup.jsonl.zst' })), fda).resolved).toHaveLength(2);
    });
});

describe('N1-N10/N12/N17-N20 fail closed at extraction/spec gates', () => {
    it('N1 absent approved field -> LOCATOR_FIELD_ABSENT', () => {
        const o = JSON.parse(body().toString()); delete o.snapshot_date;
        expect(extractLocators(Buffer.from(JSON.stringify(o)), specs()).unresolved).toContainEqual(expect.objectContaining({ reason_code: 'LOCATOR_FIELD_ABSENT' }));
    });
    it('N2/N17 wildcard, JSONPath, and prototype field paths are spec-invalid', () => {
        for (const field_path of ['*', '$.x', '__proto__', 'constructor']) {
            const s = { ...specs()[0], field_path };
            expect(validateLocatorSpecAgainstRule(s, specs()[0]).length).toBeGreaterThan(0);
        }
    });
    it('N3/N4 object or array scalar -> LOCATOR_TYPE_MISMATCH', () => {
        for (const value of [{ x: 1 }, ['x']]) {
            const r = extractLocators(body({ snapshot_date: value }), specs());
            expect(r.unresolved).toContainEqual(expect.objectContaining({ spec_id: 'SYN_SNAPSHOT_DATE', reason_code: 'LOCATOR_TYPE_MISMATCH' }));
        }
    });
    it('N5 overlength -> LOCATOR_OVERLENGTH', () => {
        const ss = specs(); ss.find((s) => s.field_path === 'snapshot_id').max_utf8_bytes = 2;
        expect(extractLocators(body(), ss).unresolved).toContainEqual(expect.objectContaining({ reason_code: 'LOCATOR_OVERLENGTH' }));
    });
    it('N6/N12 semantic mismatch or prose -> LOCATOR_VALUE_INVALID', () => {
        expect(extractLocators(body({ snapshot_date: 'not-a-date' }), specs()).unresolved).toContainEqual(expect.objectContaining({ spec_id: 'SYN_SNAPSHOT_DATE', reason_code: 'LOCATOR_VALUE_INVALID' }));
        const prose = extractLocators(body({ snapshot_date: 'scientific payload prose must never pass' }), specs());
        expect(prose.resolved.some((row) => row.spec_id === 'SYN_SNAPSHOT_DATE')).toBe(false);
    });
    it('N7/N20 segment traversal, dot, repeated slash, whitespace, slash, backslash, controls reject', () => {
        for (const value of ['snapshots/../x/', 'snapshots/./x/', 'snapshots//x/', '/snapshots/x/', ' snapshots/x/', 'snapshots\\x/', 'snapshots/\u0001x/']) {
            expect(safePathSegments(value, { allowTrailingSlash: true }).ok).toBe(false);
        }
        expect(extractLocators(body({ object_prefix: ' snapshots/2026-01-01/1-1/' }), specs()).unresolved).toContainEqual(expect.objectContaining({ spec_id: 'SYN_OBJECT_PREFIX', reason_code: 'LOCATOR_SEGMENT_INVALID' }));
    });
    it('N8 wrong manifest relation -> cross-field failure', () => {
        const r = extractLocators(body({ compounds_manifest_key: 'snapshots/2026-01-01/1-1/other.json' }), specs());
        expect(r.unresolved).toContainEqual(expect.objectContaining({ spec_id: 'SYN_COMPOUNDS_MANIFEST', reason_code: 'LOCATOR_CROSS_FIELD_FAIL' }));
    });
    it('N9/N10 mixed or unknown layout fails the whole group', () => {
        const legacy = { ...specs()[0], spec_id: 'LEGACY_DATE', field_path: 'latest_snapshot_date', semantic_type: 'SNAPSHOT_DATE', value_pattern_id: 'ISO_DATE', pointer_shape: 'legacy_v1', cross_field_rules: [] };
        for (const raw of [body({ latest_snapshot_date: '2026-01-01' }), body({ layout_version: 'future_v9' })]) {
            const r = extractLocators(raw, [...specs(), legacy]);
            expect(r.group_status).toBe('LAYOUT_INVALID');
            expect(r.resolved).toEqual([]);
        }
    });
    it('CE7/N18/N39 literal and decoded-unicode duplicate keys reject before JSON.parse', () => {
        const q = String.fromCharCode(34);
        expect(scanTopLevelJsonKeys(`{${q}snapshot_id${q}:${q}a${q},${q}snapshot_id${q}:${q}b${q}}`).ok).toBe(false);
        expect(scanTopLevelJsonKeys(`{${q}snapshot_id${q}:${q}a${q},${q}snapshot\\u005fid${q}:${q}b${q}}`).ok).toBe(false);
        const dup = `{${q}layout_version${q}:${q}immutable_snapshot_v2${q},${q}layout_version${q}:${q}immutable_snapshot_v2${q}}`;
        expect(extractLocators(Buffer.from(dup), specs()).group_status).toBe('DUPLICATE_KEY');
    });
});

describe('N27/N30/N31/N38/N40/N47 semantic and two-phase closure', () => {
    it('CE14/N27/N47 boolean scalar_type is never admissible', () => {
        const s = { ...specs()[0], scalar_type: 'boolean' };
        expect(validateLocatorSpecAgainstRule(s, specs()[0]).some((e) => /scalar_type/.test(e))).toBe(true);
    });
    it('N30/N31 traversal-free but source-wrong object keys fail derived equality', () => {
        const cursor = [
            { spec_id: 'REL', key: 'synthetic/state/cursor.json', field_path: 'release', semantic_type: 'RELEASE_TOKEN', value_pattern_id: 'RELEASE_TOKEN_SEGMENT', scalar_type: 'string', max_utf8_bytes: 64, required: true, pointer_shape: 'cursor_v1', normalization: 'NONE', cross_field_rules: ['RELEASE_TOKEN_SINGLE_SEGMENT'] },
            { spec_id: 'KEY', key: 'synthetic/state/cursor.json', field_path: 'r2_data_key', semantic_type: 'OBJECT_KEY', value_pattern_id: 'R2_DATA_KEY_PATHSAFE', scalar_type: 'string', max_utf8_bytes: 256, required: true, pointer_shape: 'cursor_v1', normalization: 'NONE', cross_field_rules: ['UMLS_MESH_KEY_EQUALS_RELEASE_PATH'] },
        ];
        for (const key of ['secrets/foo', 'internal/processed/bulk/umls/2025AB/loinc-concepts.jsonl.zst']) {
            expect(extractLocators(Buffer.from(JSON.stringify({ release: '2025AB', r2_data_key: key })), cursor).unresolved).toContainEqual(expect.objectContaining({ spec_id: 'KEY' }));
        }
    });
    it('CE6/N38 snapshot date mismatch fails its cross-field rule', () => {
        expect(extractLocators(body({ snapshot_id: '2026-01-02/1-1', object_prefix: 'snapshots/2026-01-02/1-1/', compounds_manifest_key: 'snapshots/2026-01-02/1-1/compounds/bucket-0000/manifest.json' }), specs()).unresolved).toContainEqual(expect.objectContaining({ spec_id: 'SYN_SNAPSHOT_ID', reason_code: 'LOCATOR_CROSS_FIELD_FAIL' }));
    });
    it('CE8/N40 order is irrelevant and failed peer yields exactly LOCATOR_DEPENDENCY_INVALID', () => {
        const broken = body({ snapshot_id: 'bad', object_prefix: 'snapshots/2026-01-01/1-1/' });
        const a = extractLocators(broken, specs());
        const b = extractLocators(broken, specs().reverse());
        expect(a.unresolved.find((u) => u.spec_id === 'SYN_OBJECT_PREFIX')?.reason_code).toBe('LOCATOR_DEPENDENCY_INVALID');
        expect(b.unresolved.find((u) => u.spec_id === 'SYN_OBJECT_PREFIX')?.reason_code).toBe('LOCATOR_DEPENDENCY_INVALID');
    });
});
