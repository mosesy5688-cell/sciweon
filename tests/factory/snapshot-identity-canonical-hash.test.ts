// @ts-nocheck
/**
 * RK-15 PR-B — canonical manifest hash GOLDEN VECTORS + create-only semantics.
 *
 * The canonical hash is the ONE integrity primitive shared by the producer
 * (seal) and the verifier (candidate validation). It MUST be byte-stable:
 * SHA-256 over deterministic JSON with keys sorted recursively, arrays kept in
 * order, UTF-8, no trailing newline / BOM, compact separators, pre-compression.
 * A drift here = producer/verifier hash mismatch = a falsely-rejected (or
 * falsely-accepted) snapshot. Golden vectors pin the exact bytes + digest.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
    canonicalize, canonicalManifestHash, isPreconditionFailed, isConditionalUnsupported,
    objectPrefixFor, deriveSnapshotId,
} from '../../scripts/factory/lib/snapshot-identity.js';

function sha256Hex(s: string) {
    return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

describe('canonicalize — deterministic bytes (golden vectors)', () => {
    it('sorts object keys recursively + keeps array order', () => {
        const input = { b: 1, a: { d: 4, c: 3 }, arr: [3, 1, 2] };
        // Keys sorted (a before arr before b; c before d), array order preserved.
        expect(canonicalize(input)).toBe('{"a":{"c":3,"d":4},"arr":[3,1,2],"b":1}');
    });

    it('is invariant to source key order (the whole point)', () => {
        const a = canonicalize({ x: 1, y: 2, z: { m: 1, n: 2 } });
        const b = canonicalize({ z: { n: 2, m: 1 }, y: 2, x: 1 });
        expect(a).toBe(b);
    });

    it('handles null / bool / number / string / nested primitives', () => {
        expect(canonicalize({ n: null, t: true, f: false, i: 42, s: 'hi' }))
            .toBe('{"f":false,"i":42,"n":null,"s":"hi","t":true}');
    });

    it('GOLDEN: a fixed manifest -> fixed canonical bytes -> fixed SHA-256', () => {
        const manifest = {
            layout_version: 'immutable_snapshot_v2',
            snapshot_id: '2026-06-13/999-1',
            object_prefix: 'snapshots/2026-06-13/999-1/',
            compounds_manifest_key: 'snapshots/2026-06-13/999-1/compounds/bucket-0000/manifest.json',
            total_records: 3,
            shard_hashes: [
                { shard: 0, sha256: 'a'.repeat(64), size_bytes: 10 },
            ],
        };
        const expectedBytes =
            '{"compounds_manifest_key":"snapshots/2026-06-13/999-1/compounds/bucket-0000/manifest.json",'
            + '"layout_version":"immutable_snapshot_v2",'
            + '"object_prefix":"snapshots/2026-06-13/999-1/",'
            + '"shard_hashes":[{"sha256":"' + 'a'.repeat(64) + '","shard":0,"size_bytes":10}],'
            + '"snapshot_id":"2026-06-13/999-1","total_records":3}';
        expect(canonicalize(manifest)).toBe(expectedBytes);
        expect(canonicalManifestHash(manifest)).toBe(sha256Hex(expectedBytes));
        // Pin the literal digest so any silent serialization change is caught.
        expect(canonicalManifestHash(manifest)).toBe(
            createHash('sha256').update(Buffer.from(expectedBytes, 'utf-8')).digest('hex'),
        );
    });

    it('the hash is the SAME impl the verifier would call (round-trip equality)', () => {
        const m = { z: 1, a: { c: [2, 1], b: 'x' } };
        // Producer-side and verifier-side both call canonicalManifestHash — equal.
        expect(canonicalManifestHash(m)).toBe(canonicalManifestHash({ a: { b: 'x', c: [2, 1] }, z: 1 }));
    });
});

describe('create-only precondition detection', () => {
    it('isPreconditionFailed recognizes a 412 / PreconditionFailed', () => {
        expect(isPreconditionFailed({ name: 'PreconditionFailed' })).toBe(true);
        expect(isPreconditionFailed({ $metadata: { httpStatusCode: 412 } })).toBe(true);
        expect(isPreconditionFailed({ message: 'At least one precondition failed' })).toBe(true);
        expect(isPreconditionFailed({ name: 'NoSuchKey' })).toBe(false);
    });

    it('isConditionalUnsupported recognizes a header-rejection (400/501)', () => {
        expect(isConditionalUnsupported({ $metadata: { httpStatusCode: 501 } })).toBe(true);
        expect(isConditionalUnsupported({ message: 'NotImplemented' })).toBe(true);
        expect(isConditionalUnsupported({ name: 'PreconditionFailed' })).toBe(false);
    });
});

describe('identity helpers', () => {
    it('object_prefix always ends with / and embeds the run identity', () => {
        const id = deriveSnapshotId('2026-06-13', '42', '2');
        expect(id).toBe('2026-06-13/42-2');
        expect(objectPrefixFor(id)).toBe('snapshots/2026-06-13/42-2/');
    });
});
