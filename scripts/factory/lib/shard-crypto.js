/**
 * Shard crypto stub — I-7a Phase 1 (no-op).
 *
 * scripts/factory/lib/shard-writer.js imports initShardCrypto + encryptPayload
 * from this module. Original ai-nexus design used AES-CTR per-entity encryption.
 * Sciweon I-7a Phase 1 ships WITHOUT encryption (no SHARD_AES_KEY secret yet
 * + per Gemini review 2026-05-21 Concern #2 the worker decoder uses no-op
 * passthrough). Phase 2+ may enable encryption by populating these functions.
 *
 * Contract:
 *   initShardCrypto() returns truthy iff encryption is enabled. Returning null
 *   disables encryption in ShardWriter.writeEntity (line 74 check).
 *   encryptPayload is never called when initShardCrypto returns null.
 */

export function initShardCrypto() {
    // Phase 1: encryption disabled. Returning null tells ShardWriter to skip
    // the encryptPayload call entirely (see shard-writer.js line 74).
    return null;
}

export function encryptPayload(/* shardName, payload, offset */) {
    // Defensive no-op. Should never be invoked because initShardCrypto returns null.
    throw new Error('encryptPayload called but Phase 1 disables encryption — initShardCrypto must return null');
}
