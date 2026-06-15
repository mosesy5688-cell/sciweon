/**
 * RK-16A2 — ProducerTuple builder + activation guard (PURE MECHANISM).
 *
 * Builds the ProducerTuple that makes a shard's bytes reproducible (conforms to
 * manifest-schema.ts validateProducerTuple). The codec_impl is DETECTED at build
 * time: 'rust-ffi' (native, deterministic) vs 'wasm' (fallback). The WASM
 * fallback frames are the determinism risk, so a WASM-built artifact is
 * dev-diagnostic ONLY and MUST NOT be activatable.
 *
 * A2 does NOT publish; it ships the guard (assertActivatableCodec) and records
 * the detected impl. OFFLINE/FIXTURE use only.
 */

import { createRequire } from 'module';

/**
 * Mirrors src/worker/lib/rk16/manifest-schema.ts CRYPTO_MODE_PASSTHROUGH. The
 * Node producer cannot import the worker TS at runtime; the literal is locked by
 * validateProducerTuple (which requires exactly this value) + a unit test.
 */
export const CRYPTO_MODE_PASSTHROUGH = 'passthrough_v1';

/** The ONLY codec_impl an activatable artifact may carry. */
export const PINNED_CODEC_IMPL = 'rust-ffi';

export const CODEC_NAME = 'zstd';
export const CODEC_LEVEL = 3;
export const CODEC_VERSION = '1.x';
export const RECORD_SERIALIZATION = 'canonical_json';
export const SERIALIZATION_VERSION = 'v1';
export const SORT_ORDER = '(index_key asc, record_id asc)';

/**
 * Detect which zstd implementation is available WITHOUT importing the codec
 * module (avoids side effects + keeps this offline). Mirrors zstd-helper.js
 * probeRust(): the Rust FFI native addon present => 'rust-ffi', else 'wasm'.
 */
export function detectCodecImpl() {
    try {
        const req = createRequire(import.meta.url);
        const rust = req('../../../../rust/stream-aggregator/stream-aggregator-rust.node');
        if (rust && rust.zstdCompressBuffer) return 'rust-ffi';
    } catch {
        // native addon unavailable -> WASM fallback path
    }
    return 'wasm';
}

/** Build a ProducerTuple. `codecImpl` defaults to the detected impl. */
export function buildProducerTuple(codecImpl = detectCodecImpl()) {
    return {
        codec_name: CODEC_NAME,
        codec_impl: codecImpl,
        codec_version: CODEC_VERSION,
        codec_level: CODEC_LEVEL,
        dictionary_hash: null,
        crypto_mode: CRYPTO_MODE_PASSTHROUGH,
        record_serialization: RECORD_SERIALIZATION,
        serialization_version: SERIALIZATION_VERSION,
        sort_order: SORT_ORDER,
    };
}

/**
 * THROW unless the tuple was produced by the pinned (deterministic) codec impl.
 * A WASM-fallback artifact is dev-diagnostic only and is NOT activatable.
 */
export function assertActivatableCodec(tuple) {
    if (!tuple || tuple.codec_impl !== PINNED_CODEC_IMPL) {
        throw new Error(
            `[NOT-ACTIVATABLE] codec_impl="${tuple && tuple.codec_impl}" — only ` +
            `"${PINNED_CODEC_IMPL}" produces deterministic frames; a WASM-fallback ` +
            `artifact is dev-diagnostic only and MUST NOT be activated.`,
        );
    }
}
