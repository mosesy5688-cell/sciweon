/**
 * RK-15 PR-A — dual-contract reader + per-request SnapshotContext (unit tests).
 *
 * parseSnapshotContext is pure (no I/O): it decides EXACTLY one of two precise
 * contracts (legacy_v1 / immutable_snapshot_v2) or fails LOUD. These tests lock:
 *   - legacy_v1 exact schema parses (date-keyed; current live shape)
 *   - immutable_v2 exact schema parses (keys come from declared fields)
 *   - v1 + partial v2 fields -> fail-loud
 *   - v2 missing a key field -> fail-loud
 *   - unknown layout_version -> fail-loud
 *   - empty / corrupt latest -> fail-loud
 *   - v1/v2 detection is mutually exclusive across all 4 bad-input classes
 */

import { describe, it, expect } from 'vitest';
import {
    parseSnapshotContext, SnapshotContractError, snapshotIdentityToken,
    loadSnapshotContext,
} from './snapshot-context';

describe('parseSnapshotContext — legacy_v1 (the current live contract)', () => {
    it('matches the EXACT current pointer (only latest_snapshot_date)', () => {
        const ctx = parseSnapshotContext(JSON.stringify({ latest_snapshot_date: '2026-05-19' }));
        expect(ctx.layout_version).toBe('legacy_v1');
        expect(ctx.snapshot_id).toBe('2026-05-19');
        expect(ctx.snapshot_date).toBe('2026-05-19');
        expect(ctx.object_prefix).toBe('snapshots/2026-05-19/');
        // v1 derives keys from the date downstream -> declared keys are null.
        expect(ctx.compounds_manifest_key).toBeNull();
        expect(ctx.neg_evidence_manifest_key).toBeNull();
        expect(ctx.xref_index_key).toBeNull();
        expect(ctx.manifest_hash).toBeNull();
    });

    it('tolerates the live pointer also carrying date-derived manifest hints (not authoritative)', () => {
        // The real live latest carries these as date-derived hints; v1 ignores
        // them for key derivation but they must NOT make it ambiguous.
        const ctx = parseSnapshotContext(JSON.stringify({
            latest_snapshot_date: '2026-05-19',
            compounds_manifest_key: 'snapshots/2026-05-19/compounds/bucket-0000/manifest.json',
            neg_evidence_manifest_key: 'snapshots/2026-05-19/neg-evidence/bucket-0000/manifest.json',
            manifest_key: 'snapshots/2026-05-19/manifest.json',
        }));
        expect(ctx.layout_version).toBe('legacy_v1');
        expect(ctx.object_prefix).toBe('snapshots/2026-05-19/');
    });

    it('is frozen (immutable per-request context)', () => {
        const ctx = parseSnapshotContext(JSON.stringify({ latest_snapshot_date: '2026-05-19' }));
        expect(Object.isFrozen(ctx)).toBe(true);
    });
});

describe('parseSnapshotContext — immutable_snapshot_v2', () => {
    const v2 = {
        layout_version: 'immutable_snapshot_v2',
        snapshot_id: 'snap-2026-06-13-abc123',
        object_prefix: 'snapshots/snap-2026-06-13-abc123',
        compounds_manifest_key: 'snapshots/snap-2026-06-13-abc123/compounds/bucket-0000/manifest.json',
        neg_evidence_manifest_key: 'snapshots/snap-2026-06-13-abc123/neg-evidence/bucket-0000/manifest.json',
        xref_index_key: 'snapshots/snap-2026-06-13-abc123/xref-index.json.gz',
        manifest_hash: 'sha256:deadbeef',
        commit_sha: 'abc123',
    };

    it('parses the exact v2 schema; keys come from DECLARED fields', () => {
        const ctx = parseSnapshotContext(JSON.stringify(v2));
        expect(ctx.layout_version).toBe('immutable_snapshot_v2');
        expect(ctx.snapshot_id).toBe('snap-2026-06-13-abc123');
        expect(ctx.compounds_manifest_key).toBe(v2.compounds_manifest_key);
        expect(ctx.neg_evidence_manifest_key).toBe(v2.neg_evidence_manifest_key);
        expect(ctx.xref_index_key).toBe(v2.xref_index_key);
        expect(ctx.manifest_hash).toBe('sha256:deadbeef');
    });

    it('normalizes object_prefix to end with /', () => {
        const ctx = parseSnapshotContext(JSON.stringify(v2));
        expect(ctx.object_prefix).toBe('snapshots/snap-2026-06-13-abc123/');
    });

    it('optional declared keys may be absent (null), required ones must be present', () => {
        const minimal = {
            layout_version: 'immutable_snapshot_v2',
            snapshot_id: 's1',
            object_prefix: 'snapshots/s1/',
            compounds_manifest_key: 'snapshots/s1/compounds/bucket-0000/manifest.json',
        };
        const ctx = parseSnapshotContext(JSON.stringify(minimal));
        expect(ctx.layout_version).toBe('immutable_snapshot_v2');
        expect(ctx.neg_evidence_manifest_key).toBeNull();
        expect(ctx.xref_index_key).toBeNull();
    });
});

describe('parseSnapshotContext — FAIL-LOUD on all 4 bad-input classes (mutual exclusivity)', () => {
    it('(i) v1 fields + some v2-only fields -> SnapshotContractError (never read as v1)', () => {
        expect(() => parseSnapshotContext(JSON.stringify({
            latest_snapshot_date: '2026-05-19',
            snapshot_id: 'snap-x', // v2-only field with no layout_version
        }))).toThrow(SnapshotContractError);
    });

    it('(ii) v2 token but MISSING snapshot_id -> fail-loud (never demoted to v1)', () => {
        expect(() => parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2',
            object_prefix: 'snapshots/s1/',
            compounds_manifest_key: 'snapshots/s1/compounds/bucket-0000/manifest.json',
        }))).toThrow(/missing snapshot_id/);
    });

    it('(ii) v2 token but MISSING compounds_manifest_key -> fail-loud', () => {
        expect(() => parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2',
            snapshot_id: 's1',
            object_prefix: 'snapshots/s1/',
        }))).toThrow(/missing compounds_manifest_key/);
    });

    it('(iii) unknown layout_version -> fail-loud', () => {
        expect(() => parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v3',
            latest_snapshot_date: '2026-05-19',
        }))).toThrow(/unknown layout_version/);
    });

    it('(iv) empty object -> fail-loud', () => {
        expect(() => parseSnapshotContext('{}')).toThrow(/empty/);
    });

    it('(iv) corrupt / unparseable -> fail-loud', () => {
        expect(() => parseSnapshotContext('{not json')).toThrow(/corrupt|unparseable/);
    });

    it('(iv) non-object JSON -> fail-loud', () => {
        expect(() => parseSnapshotContext('[1,2,3]')).toThrow(SnapshotContractError);
    });

    it('legacy_v1 with a non-ISO date -> fail-loud', () => {
        expect(() => parseSnapshotContext(JSON.stringify({ latest_snapshot_date: 'yesterday' })))
            .toThrow(/not an ISO date/);
    });

    it('legacy_v1 with no date at all -> fail-loud', () => {
        expect(() => parseSnapshotContext(JSON.stringify({ some_other_field: 1 })))
            .toThrow(/missing a string latest_snapshot_date/);
    });

    it('NO try-v2-then-fall-back: a v2-shaped-but-broken pointer never silently becomes v1', () => {
        // It carries the v2 token; a missing key MUST throw, not fall back to a
        // date-derived v1 read.
        expect(() => parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2',
            snapshot_id: 's1',
            latest_snapshot_date: '2026-05-19', // would-be v1 escape hatch — must NOT be taken
            // compounds_manifest_key / object_prefix missing
        }))).toThrow(SnapshotContractError);
    });
});

describe('snapshotIdentityToken — identity for cache binding', () => {
    it('v1 identity is the date', () => {
        const ctx = parseSnapshotContext(JSON.stringify({ latest_snapshot_date: '2026-05-19' }));
        expect(snapshotIdentityToken(ctx)).toBe('legacy_v1:2026-05-19');
    });

    it('v2 identity is snapshot_id + manifest_hash when present', () => {
        const ctx = parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2',
            snapshot_id: 's1', object_prefix: 'snapshots/s1/',
            compounds_manifest_key: 'snapshots/s1/compounds/bucket-0000/manifest.json',
            manifest_hash: 'sha256:abc',
        }));
        expect(snapshotIdentityToken(ctx)).toBe('immutable_snapshot_v2:s1:sha256:abc');
    });

    it('two distinct snapshots NEVER share an identity token', () => {
        const a = parseSnapshotContext(JSON.stringify({ latest_snapshot_date: '2026-05-19' }));
        const b = parseSnapshotContext(JSON.stringify({ latest_snapshot_date: '2026-05-20' }));
        expect(snapshotIdentityToken(a)).not.toBe(snapshotIdentityToken(b));
    });
});

describe('loadSnapshotContext — reads latest.json exactly once', () => {
    it('calls the injected fetch exactly once with the pointer key', async () => {
        let calls = 0;
        let lastKey = '';
        const ctx = await loadSnapshotContext(async (key) => {
            calls++; lastKey = key;
            return JSON.stringify({ latest_snapshot_date: '2026-05-19' });
        });
        expect(calls).toBe(1);
        expect(lastKey).toBe('snapshots/latest.json');
        expect(ctx.layout_version).toBe('legacy_v1');
    });

    it('propagates SnapshotContractError (does not swallow)', async () => {
        await expect(loadSnapshotContext(async () => '{}')).rejects.toThrow(SnapshotContractError);
    });
});
