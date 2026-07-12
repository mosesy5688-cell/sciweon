// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { extractLocators } from '../../scripts/rc3b-audit/locator-extract.mjs';
import {
    verifySourceBinding, isSourceBoundLocatorResult, assertSourceBoundLocatorResult,
} from '../../scripts/rc3b-audit/locator-source-binding.mjs';
import { buildLocatorArtifact } from '../../scripts/rc3b-audit/locator-artifact.mjs';
import {
    syntheticRunManifest, syntheticLocatorSpecs, manifestBodyBuffer, syntheticRunMetadata,
} from '../../scripts/rc3b-audit/self-test.mjs';

const KEY = 'synthetic/prefix/manifest.json';
const goodSource = (raw) => ({ head_etag: 'e', get_etag: 'e', head_content_length: raw.length, get_content_length: raw.length });

function bind() {
    const raw = manifestBodyBuffer();
    const specs = syntheticLocatorSpecs();
    const extraction = extractLocators(raw, specs, { key: KEY });
    return { raw, specs, bound: verifySourceBinding(raw, extraction, specs, goodSource(raw)) };
}

describe('B1 post-brand mutation is closed (deep-freeze + integrity digest)', () => {
    it('freezes the root and every nested array/row of a source-bound result', () => {
        const { bound } = bind();
        expect(isSourceBoundLocatorResult(bound)).toBe(true);
        expect(Object.isFrozen(bound)).toBe(true);
        expect(Object.isFrozen(bound.resolved)).toBe(true);
        expect(Object.isFrozen(bound.unresolved)).toBe(true);
        expect(Object.isFrozen(bound.applicable_specs)).toBe(true);
        expect(Object.isFrozen(bound.optional_absent_spec_ids)).toBe(true);
        expect(Object.isFrozen(bound.resolved[0])).toBe(true);
    });

    // Each vector exercises a previously-MUTABLE nested array/slot; on the old
    // shallow-freeze these succeeded, so `toThrow` would have failed there.
    it('rejects replacing an existing resolved slot', () => {
        const { bound } = bind();
        expect(() => { bound.resolved[0] = { ...bound.resolved[0], normalized_scalar_value: 'FORGED' }; }).toThrow();
    });
    it('rejects pushing a new resolved row', () => {
        const { bound } = bind();
        expect(() => bound.resolved.push({ ...bound.resolved[0], spec_id: 'FORGED_EXTRA' })).toThrow();
    });
    it('rejects splice/reorder of resolved rows', () => {
        const { bound } = bind();
        expect(() => bound.resolved.reverse()).toThrow();
        expect(() => bound.resolved.splice(0, 1)).toThrow();
    });
    it('rejects replacing/pushing an unresolved row', () => {
        const { bound } = bind();
        expect(() => bound.unresolved.push({ spec_id: 'X', source_object_key: 'k', reason_code: 'Z' })).toThrow();
    });
    it('rejects mutating or replacing applicable_specs', () => {
        const { bound } = bind();
        expect(() => bound.applicable_specs.push({})).toThrow();
        expect(() => { bound.applicable_specs = []; }).toThrow();
    });
    it('rejects mutating or replacing optional_absent_spec_ids', () => {
        const { bound } = bind();
        expect(() => bound.optional_absent_spec_ids.push('X')).toThrow();
        expect(() => { bound.optional_absent_spec_ids = ['X']; }).toThrow();
    });

    it('digest gate: a landed post-mint mutation is rejected with SOURCE_BOUND_RESULT_MUTATED', () => {
        // Simulate a freeze regression by neutralizing Object.freeze ONLY during
        // minting, leaving the branded graph mutable. The integrity digest must
        // still catch a landed mutation independently of freeze -- proving the
        // digest, not merely strict-mode-on-a-frozen-root, is the gate.
        const raw = manifestBodyBuffer();
        const specs = syntheticLocatorSpecs();
        const extraction = extractLocators(raw, specs, { key: KEY });
        const spy = vi.spyOn(Object, 'freeze').mockImplementation((o) => o);
        let bound;
        try { bound = verifySourceBinding(raw, extraction, specs, goodSource(raw)); } finally { spy.mockRestore(); }
        expect(isSourceBoundLocatorResult(bound)).toBe(true);
        expect(() => assertSourceBoundLocatorResult(bound)).not.toThrow();
        // Landed tamper of the previously-mutable nested array slot.
        bound.resolved[0] = { ...bound.resolved[0], normalized_scalar_value: 'FORGED::not-from-source' };
        expect(() => assertSourceBoundLocatorResult(bound)).toThrow(/SOURCE_BOUND_RESULT_MUTATED/);
    });

    it('digest gate: a landed push into unresolved is rejected with SOURCE_BOUND_RESULT_MUTATED', () => {
        const raw = manifestBodyBuffer();
        const specs = syntheticLocatorSpecs();
        const extraction = extractLocators(raw, specs, { key: KEY });
        const spy = vi.spyOn(Object, 'freeze').mockImplementation((o) => o);
        let bound;
        try { bound = verifySourceBinding(raw, extraction, specs, goodSource(raw)); } finally { spy.mockRestore(); }
        bound.unresolved.push({ spec_id: 'X', source_object_key: 'k', reason_code: 'Z' });
        expect(() => assertSourceBoundLocatorResult(bound)).toThrow(/SOURCE_BOUND_RESULT_MUTATED/);
    });

    it('a coherent forged V2 lookalike (genuine provenance copied) is rejected before serialization', () => {
        const { bound } = bind();
        const plan = syntheticRunManifest();
        // Reconstruct an internally-consistent copy: same rows, recomputed value
        // hashes, and the GENUINE source ETag/byte-length/source-byte hash. It
        // never passed through mint, so it carries neither brand nor digest.
        const forged = JSON.parse(JSON.stringify(bound));
        expect(isSourceBoundLocatorResult(forged)).toBe(false);
        expect(() => assertSourceBoundLocatorResult(forged)).toThrow(/UNBOUND_ROWS_REJECTED/);
        expect(() => buildLocatorArtifact({ sourceBoundResults: [forged], plan, runMetadata: syntheticRunMetadata(plan) }))
            .toThrow(/UNBOUND_ROWS_REJECTED/);
    });

    it('positive control: an unmodified source-bound result still builds end-to-end', () => {
        const { bound } = bind();
        const plan = syntheticRunManifest();
        const built = buildLocatorArtifact({ sourceBoundResults: [bound], plan, runMetadata: syntheticRunMetadata(plan) });
        expect(built.schema.valid).toBe(true);
        const row = built.artifact.resolved_locators.find((r) => r.spec_id === 'SYN_LAYOUT_VERSION');
        expect(row.normalized_scalar_value).toBe('immutable_snapshot_v2');
    });
});

describe('B2 fail-closed HEAD/GET consistency', () => {
    const run = (over) => {
        const raw = manifestBodyBuffer();
        const specs = syntheticLocatorSpecs();
        const extraction = extractLocators(raw, specs, { key: KEY });
        return verifySourceBinding(raw, extraction, specs, { ...goodSource(raw), ...over });
    };

    it('present-and-matching HEAD/GET metadata still passes', () => {
        const r = run({});
        expect(isSourceBoundLocatorResult(r)).toBe(true);
        expect(r.source_binding_status).toBe('PASS');
    });

    const cases: [string, Record<string, unknown>][] = [
        ['missing HEAD ETag', { head_etag: undefined }],
        ['missing GET ETag', { get_etag: undefined }],
        ['missing HEAD ContentLength', { head_content_length: undefined }],
        ['missing GET ContentLength', { get_content_length: undefined }],
        ['HEAD ETag != GET ETag', { head_etag: 'a', get_etag: 'b' }],
        ['HEAD ContentLength != GET ContentLength', { head_content_length: 999999 }],
        // HEAD==GET but both diverge from the actual Buffer length: exercises the
        // declared-vs-actual comparison (defense-in-depth).
        ['declared ContentLength != actual Buffer length', { head_content_length: 5, get_content_length: 5 }],
    ];
    for (const [label, over] of cases) {
        it(`${label} -> INTEGRITY_ANOMALY`, () => {
            expect(() => run(over)).toThrow(/INTEGRITY_ANOMALY/);
        });
    }
});
