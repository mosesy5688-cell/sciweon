// @ts-nocheck
/**
 * RK-15 PR-B ★ — the producer's v2 key layout MUST match the deployed reader's
 * derivation BYTE-FOR-BYTE. A mismatch = the v2 read 404s = re-creating the bug.
 *
 * The producer (Node.js) cannot import the worker TS at runtime, so this test
 * REPLICATES the reader's documented v2 derivation (src/worker/lib/*) and asserts
 * the producer's snapshot-identity key helpers produce keys the reader resolves:
 *   - compound manifest/shard: reader strips compounds_manifest_key at
 *     '/compounds/' -> bucket prefix -> shards are siblings (compound-bucket-router.ts)
 *   - xref: reader reads the DECLARED xref_index_key verbatim (xref-index-loader.ts)
 *   - neg manifest/shard: reader strips neg_evidence_manifest_key at
 *     '/neg-evidence/' -> shards are siblings (neg-shard-router.ts)
 *   - search corpus: reader reads `${object_prefix}compounds-search.jsonl.gz`
 *     (compound-search.ts)
 */

import { describe, it, expect } from 'vitest';
import {
    objectPrefixFor, deriveSnapshotId,
    compoundsManifestKey, compoundsShardKey,
    negManifestKey, negShardKey, negEvidenceRootKey,
    xrefIndexKey, searchProjectionKey,
} from '../../scripts/factory/lib/snapshot-identity.js';

// ── Reader derivation, replicated verbatim from the deployed worker TS ────────
function pad4(n: number) { return String(n).padStart(4, '0'); }
function pad3(n: number) { return String(n).padStart(3, '0'); }

// compound-bucket-router.ts v2CompoundsRoot + manifestKeyForCtx/shardKeyForCtx.
function readerCompoundsRoot(compoundsManifestKeyDeclared: string) {
    const marker = '/compounds/';
    const i = compoundsManifestKeyDeclared.indexOf(marker);
    if (i < 0) throw new Error('no /compounds/ segment');
    return compoundsManifestKeyDeclared.slice(0, i + marker.length); // ends 'compounds/'
}
function readerManifestKey(root: string, bucket: number) {
    return `${root}bucket-${pad4(bucket)}/manifest.json`;
}
function readerShardKey(root: string, bucket: number, shard: number) {
    return `${root}bucket-${pad4(bucket)}/shard-${pad3(shard)}.bin`;
}
// neg-shard-router.ts v2NegRoot + negShardKeyForCtx/negManifestKeyForCtx.
function readerNegRoot(negKeyDeclared: string) {
    const marker = '/neg-evidence/';
    const i = negKeyDeclared.indexOf(marker);
    if (i < 0) throw new Error('no /neg-evidence/ segment');
    return negKeyDeclared.slice(0, i + marker.length); // ends 'neg-evidence/'
}
function readerNegManifestKey(root: string, bucket: number) {
    return `${root}bucket-${pad4(bucket)}/manifest.json`;
}
function readerNegShardKey(root: string, bucket: number, shard: number) {
    return `${root}bucket-${pad4(bucket)}/shard-${pad3(shard)}.bin`;
}

const ID = deriveSnapshotId('2026-06-13', '777', '1');
const PREFIX = objectPrefixFor(ID); // snapshots/2026-06-13/777-1/

describe('producer v2 key layout == reader derivation', () => {
    it('object_prefix is the reader-normalized form (ends with /)', () => {
        expect(PREFIX).toBe('snapshots/2026-06-13/777-1/');
        expect(PREFIX.endsWith('/')).toBe(true);
    });

    it('compound manifest + shards: reader strips at /compounds/ and finds the producer keys', () => {
        const declared = compoundsManifestKey(PREFIX, 0);
        // The reader receives `declared` as compounds_manifest_key, derives root.
        const root = readerCompoundsRoot(declared);
        // Reader's re-derived manifest key == the producer's declared key.
        expect(readerManifestKey(root, 0)).toBe(declared);
        // Reader's shard key (bucket 0, shard 5) == the producer's shard key.
        expect(readerShardKey(root, 0, 5)).toBe(compoundsShardKey(PREFIX, 0, 5));
        // And it sits under the object_prefix.
        expect(compoundsShardKey(PREFIX, 0, 5))
            .toBe('snapshots/2026-06-13/777-1/compounds/bucket-0000/shard-005.bin');
    });

    it('xref: reader reads the DECLARED xref_index_key verbatim', () => {
        expect(xrefIndexKey(PREFIX)).toBe('snapshots/2026-06-13/777-1/xref-index.json.gz');
    });

    it('neg manifest + shards: reader strips at /neg-evidence/ and finds the producer keys', () => {
        const declaredManifest = negManifestKey(PREFIX, 0);
        // The neg "pointer" the producer puts in latest is the neg-evidence root;
        // the reader normalizes EITHER the root or a per-bucket key at /neg-evidence/.
        const rootFromPointer = readerNegRoot(negEvidenceRootKey(PREFIX) + 'bucket-0000/manifest.json');
        expect(readerNegManifestKey(rootFromPointer, 0)).toBe(declaredManifest);
        expect(readerNegShardKey(rootFromPointer, 0, 3)).toBe(negShardKey(PREFIX, 0, 3));
        expect(negShardKey(PREFIX, 0, 3))
            .toBe('snapshots/2026-06-13/777-1/neg-evidence/bucket-0000/shard-003.bin');
    });

    it('search corpus: reader reads ${object_prefix}compounds-search.jsonl.gz', () => {
        expect(searchProjectionKey(PREFIX)).toBe(`${PREFIX}compounds-search.jsonl.gz`);
    });

    it('neg-evidence root pointer normalizes to the same /neg-evidence/ root', () => {
        const root = readerNegRoot(negEvidenceRootKey(PREFIX));
        expect(root).toBe('snapshots/2026-06-13/777-1/neg-evidence/');
    });
});
