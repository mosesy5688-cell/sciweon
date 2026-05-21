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
 * Decompress payload bytes. Phase 1: no zstd (raw JSONL stored as-is).
 *
 * ShardWriter line 71 calls compress(bundleJson) BEFORE writeEntity. The
 * compression is per-entity zstd. But our publisher writes raw JSONL line
 * bytes directly via writer.writeEntity(rec.raw) where rec.raw is the
 * original line buffer. The ShardWriter's compress call wraps these,
 * producing zstd-compressed entity payloads.
 *
 * Phase 1 simplification: decompression handled by caller knowing payload
 * is zstd. We use fzstd (pure-JS, ~3KB) loaded dynamically. If decompress
 * fails (e.g. plaintext fallback), return bytes as text directly.
 */
export async function decompressPayload(bytes: Uint8Array): Promise<string> {
    // Try zstd first (Phase 1 default per ShardWriter compress() call)
    try {
        const fzstdMod = await import('fzstd');
        const decompressed = fzstdMod.decompress(bytes);
        return new TextDecoder('utf-8').decode(decompressed);
    } catch {
        // Fallback: treat as plaintext (Phase 1 edge case if compression was bypassed)
        return new TextDecoder('utf-8').decode(bytes);
    }
}
