// @ts-nocheck
/**
 * FIXTURES for the RC-3B-P0B read-only R2 audit harness tests. ALL fake /
 * in-memory clients, ZERO network. The recording client captures EVERY command
 * that reaches it (i.e. every would-be network call) so tests assert exact
 * request COUNTS, not merely thrown exceptions. Rejections happen in the typed
 * client / budget / guard BEFORE the command reaches the recorder, so a
 * fail-before-network case leaves `calls` shorter (usually empty).
 */
import {
    ListObjectsV2Command, HeadObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Budget } from '../../scripts/rc3b-audit/budget.mjs';
import { makeReadOnlyR2Client } from '../../scripts/rc3b-audit/readonly-client.mjs';
import { instrumentStructuralReadOnlyClient } from '../../scripts/rc3b-audit/command-guard.mjs';

export const CMD = { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand };

/** A recording client whose responder returns canned List/Head/Get responses. */
export function recordingClient(responder = () => ({})) {
    const calls: any[] = [];
    const client = {
        async send(command: any) {
            const ctor = command?.constructor?.name;
            const i = command?.input || {};
            calls.push({ ctor, key: i.Key ?? null, prefix: i.Prefix ?? null, range: i.Range ?? null });
            return responder(ctor, i, command);
        },
    };
    return { client, calls };
}

/** A minimal, VALID-shaped plan (no hashes required; the client never validates). */
export function basePlan(over: any = {}) {
    return {
        bucket: 'rc3b-synthetic-bucket',
        endpoint_or_account_binding: 'synthetic-account',
        exact_prefixes: [], structural_keys: [], class_c_head_keys: [], class_x_targets: [],
        object_class_map: {}, allowed_object_classes: ['STRUCTURAL_JSON', 'NXVF_SHARD', 'MONOLITHIC_GZIP', 'MONOLITHIC_ZSTD', 'PAYLOAD_JSONL'],
        snapshot_ids: ['2026-01-01/1-1'], caps: {},
        template_allowlist_sha256: 'a'.repeat(64),
        materialized_allowlist_sha256: 'b'.repeat(64),
        materialized_run_plan_sha256: 'c'.repeat(64),
        ...over,
    };
}

/** Build a typed read-only client over a recording fake. Returns handles + counts. */
export function buildClient(plan: any, opts: any = {}) {
    const { client, calls } = recordingClient(opts.responder);
    const budget = new Budget(opts.caps ?? plan.caps ?? {}, opts.now);
    const rc = makeReadOnlyR2Client(client, plan, budget);
    return { rc, budget, guardCounters: rc.guardCounters, calls, rawClient: client };
}

/** Build the command guard directly over a recording fake (for class tests). */
export function buildGuard(opts: any = {}) {
    const { client, calls } = recordingClient(opts.responder);
    const budget = opts.budget || new Budget({});
    const guard = instrumentStructuralReadOnlyClient(client, {
        bucket: opts.bucket ?? 'rc3b-synthetic-bucket',
        exactKeys: new Set(opts.exactKeys ?? []),
        exactPrefixes: new Set(opts.exactPrefixes ?? []),
        budget,
    });
    return { guard, calls, budget, rawClient: client };
}

/** Canned responder covering the common structural / range / head shapes. */
export function stdResponder(sizes: any = {}) {
    const shard = Buffer.concat([Buffer.from([0x4e, 0x58, 0x56, 0x46]), Buffer.alloc(60, 7)]);
    const structural = Buffer.from(JSON.stringify({ snapshot_id: 's', manifest_hash: 'h', files: [] }), 'utf-8');
    return (ctor: string, i: any) => {
        if (ctor === 'ListObjectsV2Command') return { IsTruncated: false, Contents: [{ Key: `${i.Prefix}k.json`, Size: 10, ETag: '"e"' }] };
        if (ctor === 'HeadObjectCommand') return { ETag: '"e"', ContentLength: sizes[i.Key] ?? structural.length };
        if (ctor === 'GetObjectCommand' && i.Range) return { ETag: '"e"', Body: shard };
        if (ctor === 'GetObjectCommand') return { ETag: '"e"', Body: structural };
        throw new Error(`stdResponder: unhandled ${ctor}`);
    };
}
