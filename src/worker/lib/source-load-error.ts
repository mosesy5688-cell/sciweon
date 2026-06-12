/**
 * SourceLoadError — RK-13 (SOURCE_FAILURE_CONTRACT, N-10).
 *
 * A loader that reads a source object (R2 pointer read / gunzip / line parse)
 * must NEVER return an indistinguishable `[]` when the READ itself failed:
 * empty-because-failed and empty-because-queried-clean are DIFFERENT states and
 * must be distinguishable end to end. A source failure thrown as this typed
 * error lets the caller map it to a retryable 502/503 — never serving a source
 * outage as "no evidence found".
 *
 * Mirrors the ratified `NegShardError` idiom in neg-evidence-loader.ts (a typed
 * Error class the caller maps to a LOUD status), adding the contract carriers
 * (source / query_target / failure_class / retryable / observed_at + cause).
 *
 * Scope (RK-13): the whole-file loaders (paper / bioactivity / trial). The
 * `partial_coverage` carrier is N/A here — these are whole-file reads, not
 * paged/partial harvests — so it is intentionally omitted (per design §2).
 */

/** The failure-class subset carried by a whole-file loader read. */
export type SourceFailureClass = 'source_unavailable' | 'parse_failed' | 'timeout';

export interface SourceLoadErrorFields {
    source: string;
    query_target: string;
    failure_class: SourceFailureClass;
    retryable: boolean;
    observed_at: string;
}

/**
 * Thrown when a loader's source read FAILS (not when it is queried-clean). The
 * API + MCP layers map this to a retryable status: parse_failed -> 502,
 * everything else -> 503. It must NEVER be caught-and-emptied (that re-commits
 * the source-failure-as-empty violation).
 */
export class SourceLoadError extends Error {
    readonly source: string;
    readonly query_target: string;
    readonly failure_class: SourceFailureClass;
    readonly retryable: boolean;
    readonly observed_at: string;

    constructor(fields: SourceLoadErrorFields, options?: { cause?: unknown }) {
        super(
            `Source load failed (${fields.failure_class}) for ${fields.source}:${fields.query_target}`,
            options as ErrorOptions | undefined,
        );
        this.name = 'SourceLoadError';
        this.source = fields.source;
        this.query_target = fields.query_target;
        this.failure_class = fields.failure_class;
        this.retryable = fields.retryable;
        this.observed_at = fields.observed_at;
    }
}

/**
 * Classify a caught error into the contract failure-class by message-sniff
 * (mirrors negative-evidence.ts:82,88 message-sniffing).
 *
 *   - short-read / etag-drift / not-found / disappeared / missing
 *       -> source_unavailable (retryable): the object could not be read intact.
 *   - decompression / gunzip / pointer-parse (JSON)
 *       -> parse_failed (non-retryable): the bytes are corrupt/undecodable.
 *   - timeout
 *       -> timeout (retryable).
 *   - default
 *       -> source_unavailable (retryable): fail toward "transient", never
 *          toward "no evidence".
 */
export function classifySourceLoadError(err: unknown): { failure_class: SourceFailureClass; retryable: boolean } {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    // zlib/DecompressionStream surfaces a corrupt/short gzip body as a TypeError
    // whose `.code` is a Z_* error (e.g. Z_DATA_ERROR, Z_BUF_ERROR) — and whose
    // `.message` may be EMPTY. The robust decompression-failure signal is the
    // code, not the message: a corrupt source body is a parse_failed (the file
    // could not be decoded), non-retryable.
    const code = typeof (err as { code?: unknown })?.code === 'string'
        ? (err as { code: string }).code
        : '';
    if (/^Z_/.test(code)) {
        return { failure_class: 'parse_failed', retryable: false };
    }
    if (/timeout|timed out/.test(msg)) {
        return { failure_class: 'timeout', retryable: true };
    }
    if (/short read|short range read|etag|not found|disappeared|missing/.test(msg)) {
        return { failure_class: 'source_unavailable', retryable: true };
    }
    if (/decompress|gunzip|incorrect header check|unexpected end|invalid|json|parse|unexpected token/.test(msg)) {
        return { failure_class: 'parse_failed', retryable: false };
    }
    return { failure_class: 'source_unavailable', retryable: true };
}

/**
 * Build a SourceLoadError from a caught error: classify -> emit telemetry
 * (house console.warn pattern, compound-loader.ts:113) -> return the typed
 * error for the loader to throw. Centralizes the catch body shared by the
 * three whole-file loaders.
 */
export function toSourceLoadError(source: string, queryTarget: string, err: unknown): SourceLoadError {
    const { failure_class, retryable } = classifySourceLoadError(err);
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
        `[${source}-loader] source load failed (failure_class=${failure_class} retryable=${retryable} query_target=${queryTarget}): ${detail}`,
    );
    return new SourceLoadError(
        { source, query_target: queryTarget, failure_class, retryable, observed_at: new Date().toISOString() },
        { cause: err },
    );
}
