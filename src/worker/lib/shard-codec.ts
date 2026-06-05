/**
 * Shard codec — Wave I-7a Phase 1 worker-side decoder.
 *
 * Symmetric to scripts/factory/lib/shard-writer.js (which writes NXVF V4.1
 * binary shards). Phase 1 uses no encryption + no zstd (raw JSONL bytes
 * stored as entity payload) for maximum simplicity. Phase 2+ may enable
 * encryption (per Constitution V16.1 §5.2 design intent).
 *
 * Per Gemini review 2026-05-21 Concern #2 (SHARD_AES_KEY may not exist):
 * decryptPayload uses no-op passthrough if the first byte indicates
 * plaintext or if the env var is missing. Coordinate with ShardWriter to
 * emit a flag byte if encryption is later enabled.
 *
 * Per Phase 1 ShardWriter behavior: shard-crypto.js stub returns null from
 * initShardCrypto → writeEntity() skips encryptPayload → raw payload bytes
 * are what's at the offset. No flag byte prefix in Phase 1.
 */

import type { Env } from '../../worker';

/**
 * Decrypt payload bytes. Phase 1: no-op passthrough.
 *
 * @param bytes Raw bytes from R2 Range read
 * @param shardName Used in IV derivation when encryption is enabled
 * @param offset Used in IV derivation when encryption is enabled
 * @param env Worker env (checks for SHARD_AES_KEY)
 */
export function decryptPayload(
    bytes: Uint8Array,
    _shardName: string,
    _offset: number,
    env: Env,
): Uint8Array {
    // Phase 1: no encryption applied by ShardWriter (shard-crypto.js stub
    // returns null). Any future enabling of encryption MUST coordinate with
    // ShardWriter to emit a flag byte; until then, no-op passthrough.
    if (!env.SHARD_AES_KEY) {
        return bytes;
    }
    // Phase 2+ encryption support placeholder. Implement when secret is set
    // AND ShardWriter is updated to emit encrypted output + flag byte.
    return bytes;
}

/**
 * Decompress payload bytes (zstd, per ShardWriter compression in factory).
 *
 * Wave I-7a Phase 1 perf fix: STATIC fzstd import (was dynamic).
 * Dynamic `await import('fzstd')` cost ~1s per worker cold start because
 * CF Workers re-loads the module per isolate spawn. Static import bundles
 * fzstd at deploy time (~3KB code), zero per-request overhead.
 *
 * If decompress throws (plaintext-stored Phase 1 edge case), the LENIENT path
 * (compound loader) returns bytes as text directly — caller's JSON.parse will
 * validate. The STRICT path (neg-evidence loader) HARD-FAILS on decode error
 * instead of returning a plaintext interpretation of zstd bytes: a corrupt or
 * truncated neg shard must surface as a LOUD 503, never as silently-wrong
 * "negative evidence" text (per [[cross_cycle_silent_data_loss]] — a decode
 * failure on the safety endpoint must not become a false response).
 */
import { decompress as fzstdDecompress } from 'fzstd';

export function decompressPayload(bytes: Uint8Array, strict = false): string {
    try {
        const decompressed = fzstdDecompress(bytes);
        return new TextDecoder('utf-8').decode(decompressed);
    } catch (err) {
        if (strict) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Shard decode failure (strict): ${msg}`);
        }
        // Plaintext fallback (rare; ShardWriter line 71 always compresses)
        return new TextDecoder('utf-8').decode(bytes);
    }
}
