// @ts-nocheck
/**
 * RK-16A2 — producer tuple: passes validateProducerTuple; pinned-codec guard
 * passes for rust-ffi, THROWS for a simulated wasm tuple; crypto_mode literal.
 */
import { describe, it, expect } from 'vitest';
import {
    buildProducerTuple, assertActivatableCodec, PINNED_CODEC_IMPL, CRYPTO_MODE_PASSTHROUGH,
} from '../../../scripts/factory/lib/rk16/producer-tuple.js';
import {
    validateProducerTuple, CRYPTO_MODE_PASSTHROUGH as TS_CRYPTO_MODE,
} from '../../../src/worker/lib/rk16/manifest-schema';

describe('producer-tuple', () => {
    it('builds a tuple that passes validateProducerTuple', () => {
        const t = buildProducerTuple('rust-ffi');
        const r = validateProducerTuple(t);
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
        expect(t.codec_name).toBe('zstd');
        expect(t.codec_level).toBe(3);
        expect(t.dictionary_hash).toBeNull();
        expect(t.record_serialization).toBe('canonical_json');
        expect(t.sort_order).toBe('(index_key asc, record_id asc)');
    });

    it('crypto_mode literal matches the worker schema constant', () => {
        expect(CRYPTO_MODE_PASSTHROUGH).toBe(TS_CRYPTO_MODE);
        expect(buildProducerTuple('rust-ffi').crypto_mode).toBe(TS_CRYPTO_MODE);
    });

    it('assertActivatableCodec passes for the pinned impl, throws for wasm', () => {
        expect(PINNED_CODEC_IMPL).toBe('rust-ffi');
        expect(() => assertActivatableCodec(buildProducerTuple('rust-ffi'))).not.toThrow();
        // a WASM-fallback artifact is dev-diagnostic only -> NOT activatable
        expect(() => assertActivatableCodec(buildProducerTuple('wasm'))).toThrow(/NOT-ACTIVATABLE/);
        // even though a wasm tuple still validates structurally
        expect(validateProducerTuple(buildProducerTuple('wasm')).ok).toBe(true);
    });
});
