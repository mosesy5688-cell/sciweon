/**
 * Shard error types - extracted from neg-evidence-loader.ts (P0.1).
 *
 * neg-evidence-loader.ts sat at 249 lines (headroom 1) while declaring
 * NegShardError, so the failure contract could not grow there. This module
 * owns the shard error TYPES and the by-type classifier; the public contract
 * table itself lives in failure-contract.ts.
 *
 * These types exist to serve rule 4c.1 - classify at the throw site, BY TYPE.
 * A shard fault is split by the TYPE of its cause, never by sniffing a message.
 */

/** The two shard failure classes carried by the public contract. */
export type ShardFailureClass = 'shard_read_unavailable' | 'shard_manifest_invalid';

/**
 * Producer-data invalid: the bytes, or the JSON, that a shard/manifest
 * producer published cannot be used. Re-reading the same object cannot fix
 * it, so this class is non-retryable.
 */
export class ShardDataInvalidError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options as ErrorOptions | undefined);
        this.name = 'ShardDataInvalidError';
    }
}

/**
 * Classify a shard fault BY TYPE only.
 *
 * TypeError is deliberately ABSENT from the permanent arm. TypeError is
 * JavaScript's generic runtime fault - a null dereference, an undefined
 * binding or a mis-shaped test double all raise it - and stamping it
 * permanently non-retryable would invert the fail-toward-transient default.
 * A genuinely mis-shaped manifest is caught by the shape guard at its source
 * (neg-manifest-loader.ts), which is where rule 4c.1 says it belongs.
 *
 * Default is shard_read_unavailable (retryable).
 */
export function classifyShardCause(cause: unknown): ShardFailureClass {
    return (cause instanceof ShardDataInvalidError || cause instanceof SyntaxError)
        ? 'shard_manifest_invalid'
        : 'shard_read_unavailable';
}

/**
 * Thrown when the SHARDED neg-evidence path fails (a manifest is active but a
 * manifest/shard read threw). The API and MCP surfaces map it to a LOUD
 * failure and NEVER fall back to the legacy whole-file path.
 *
 * The failure_class is fixed AT CONSTRUCTION from the cause's type, so every
 * downstream consumer reads a structural field instead of the message text.
 */
export class NegShardError extends Error {
    readonly failure_class: ShardFailureClass;

    constructor(message: string, options?: { cause?: unknown; failure_class?: ShardFailureClass }) {
        super(message, options as ErrorOptions | undefined);
        this.name = 'NegShardError';
        this.failure_class = options?.failure_class ?? classifyShardCause(options?.cause);
    }
}
