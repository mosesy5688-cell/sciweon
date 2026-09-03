/**
 * P0.1 - the public failure contract (single exported table).
 *
 * One table maps every failure_class to its retryability, its default public
 * detail sentence and whether any throw site actually PRODUCES it. Every
 * emitting path - REST body, MCP error.data, json500 - constructs from here,
 * so `retryable` can never go missing and two routes can never disagree about
 * one class.
 *
 * Two invariants this file exists to hold:
 *   1. `retryable` is the ONLY retry carrier. HTTP status is not one: 502
 *      carries both retryable and non-retryable classes, and the same class
 *      appears at 502 on one route and 503 on another.
 *   2. A detail sentence says WHAT failed and what it does NOT mean. It never
 *      says WHEN a failure will clear, nor what future process will fix it.
 */

import { SourceLoadError } from './source-load-error';
import { SnapshotContractError } from './snapshot-context';
import { NegShardError, ShardDataInvalidError } from './neg-shard-error';
import { R2ReadError } from './r2-fetch';

export type FailureClass =
    | 'source_unavailable'
    | 'shard_read_unavailable'
    | 'parse_failed'
    | 'snapshot_contract'
    | 'shard_manifest_invalid'
    | 'data_layer_unconfigured'
    | 'unclassified'
    | 'timeout'
    | 'object_integrity';

export interface FailureContractRow {
    retryable: boolean;
    default_detail: string;
    /**
     * false = DECLARED BY THIS CONTRACT, NOT PRODUCED. The class keeps its
     * seat in the union so a future typed throw site has a home; a guard test
     * asserts no emitting path yields it, so the day one does, the test says so.
     */
    produced: boolean;
}

export const FAILURE_CONTRACT: Record<FailureClass, FailureContractRow> = {
    source_unavailable: {
        retryable: true,
        default_detail: 'A source object could not be read intact. This is a READ failure and NOT a finding that no data exists.',
        produced: true,
    },
    shard_read_unavailable: {
        retryable: true,
        default_detail: 'A sharded read could not be completed. This is a READ failure and NOT a finding that no data exists.',
        produced: true,
    },
    parse_failed: {
        retryable: false,
        default_detail: 'A source object was read but could not be decoded. This is a DECODE failure and NOT a finding that no data exists.',
        produced: true,
    },
    snapshot_contract: {
        retryable: false,
        default_detail: 'The snapshot pointer failed contract validation. Nothing is served from an unrecognized contract.',
        produced: true,
    },
    shard_manifest_invalid: {
        retryable: false,
        default_detail: 'A shard manifest failed its structural checks. This is a producer-data fault and NOT a finding that no data exists.',
        produced: true,
    },
    data_layer_unconfigured: {
        retryable: false,
        default_detail: 'The data layer binding is absent from this deployment. No read was attempted.',
        produced: true,
    },
    unclassified: {
        retryable: true,
        default_detail: 'An unexpected internal failure occurred. It is NOT a finding that no data exists.',
        produced: true,
    },
    timeout: {
        retryable: true,
        default_detail: 'A source read did not complete. This is a READ failure and NOT a finding that no data exists.',
        produced: true,
    },
    object_integrity: {
        retryable: false,
        default_detail: 'A stored object failed its own integrity check. This is a producer-data fault and NOT a finding that no data exists.',
        produced: false,
    },
};

/** Every class the contract declares, in table order. */
export const FAILURE_CLASSES = Object.keys(FAILURE_CONTRACT) as FailureClass[];

export interface FailureBody {
    error: string;
    failure_class: FailureClass;
    retryable: boolean;
    detail: string;
}

/**
 * Build a REST failure body. `detail` is an optional per-route override for a
 * route-specific sentence; omitting it takes the class default. Either way the
 * sentence must obey the forbidden-vocabulary rule.
 */
export function failureBody(error: string, failure_class: FailureClass, detail?: string): FailureBody {
    const row = FAILURE_CONTRACT[failure_class];
    return { error, failure_class, retryable: row.retryable, detail: detail ?? row.default_detail };
}

export interface FailureData {
    failure_class: FailureClass;
    retryable: boolean;
}

/**
 * Build the MCP carrier object. The JSON-RPC envelope is {code, message,
 * data?}: failure_class and retryable travel in error.data, and the message
 * carries prose only.
 */
export function failureData(failure_class: FailureClass): FailureData {
    return { failure_class, retryable: FAILURE_CONTRACT[failure_class].retryable };
}

/**
 * The shared residual classifier. It tests instanceof for EVERY typed error in
 * the union before conceding `unclassified`: a typed error reaching a residual
 * catch-all is a bug, not an unclassified fault.
 *
 * Every R2ReadError discriminant is a general transport failure and takes
 * source_unavailable / retryable true. The shard classes stay reserved for the
 * one typed shard error that produces them.
 */
export function classifyThrown(err: unknown): FailureClass {
    if (err instanceof SnapshotContractError) return 'snapshot_contract';
    if (err instanceof NegShardError) return err.failure_class;
    if (err instanceof ShardDataInvalidError) return 'shard_manifest_invalid';
    if (err instanceof SourceLoadError) return err.failure_class;
    if (err instanceof R2ReadError) return 'source_unavailable';
    return 'unclassified';
}
