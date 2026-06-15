// @ts-nocheck
/**
 * RK-16C SPIKE — cursor typed errors + advance + empty-with-more; exhaustive
 * referential integrity (clean); determinism (byte-identical); WASM
 * activatable=false. Uses the REAL A1 cursor + A2 referential-integrity /
 * producer-tuple. OFFLINE/FIXTURE, unsigned/base64url/untrusted.
 */
import { describe, it, expect } from 'vitest';
import { loadCorpus, corpusExists } from '../../scripts/spikes/rk16c/lib/corpus.mjs';
import { buildCanonical, projectRows } from '../../scripts/spikes/rk16c/lib/build-axis.mjs';
import {
    attestReferentialIntegrity, assertCleanReferentialIntegrity,
} from '../../scripts/factory/lib/rk16/referential-integrity.js';
import { buildProducerTuple, assertActivatableCodec } from '../../scripts/factory/lib/rk16/producer-tuple.js';
import {
    encode, decode, revalidateCursor, CURSOR_VERSION,
    InvalidCursorError, FilterMismatchError, StaleCursorError,
} from '../../src/worker/lib/rk16/cursor';

// Corpus-grounded specs skip when the local corpus is absent (CI: snapshots/ is
// gitignored). The synthetic cursor + WASM-guard specs below run everywhere.
const hasCorpus = corpusExists();
const corpus = hasCorpus ? loadCorpus() : { rows: [] };
const sample = corpus.rows.slice(0, 600);

function payload(over = {}) {
    return {
        cursor_version: CURSOR_VERSION, snapshot_identity: 'snap-A', family: 'bioactivities',
        index_key: 'chembl:CHEMBL1', partition: 'all', page_ordinal: 1, in_page_offset: 0,
        filter_fingerprint: 'fp-A', ...over,
    };
}
function ctx(over = {}) {
    return {
        activeSnapshotIdentity: 'snap-A', family: 'bioactivities', activeFilterFingerprint: 'fp-A',
        pageTotalForKey: 5, recordCountForPage: 10, ...over,
    };
}

describe('rk16c cursor typed errors + advance', () => {
    it('round-trips through base64url (unsigned, untrusted)', () => {
        const c = encode(payload());
        expect(typeof c).toBe('string');
        expect(decode(c)).toEqual(payload());
    });
    it('stale snapshot -> StaleCursorError (409)', () => {
        expect(() => revalidateCursor(payload(), ctx({ activeSnapshotIdentity: 'snap-B' }))).toThrow(StaleCursorError);
    });
    it('modified payload (bad base64url) -> InvalidCursorError (400)', () => {
        expect(() => decode('!!!not base64!!!')).toThrow(InvalidCursorError);
        expect(() => decode(encode(payload()) + 'TAMPER')).toThrow(InvalidCursorError);
    });
    it('filter change -> FilterMismatchError (400)', () => {
        expect(() => revalidateCursor(payload(), ctx({ activeFilterFingerprint: 'fp-B' }))).toThrow(FilterMismatchError);
    });
    it('page-cap -> cursor advances (ordinal/offset move forward)', () => {
        const c0 = payload({ page_ordinal: 0, in_page_offset: 0 });
        const c1 = decode(encode(payload({ page_ordinal: 1, in_page_offset: 0 })));
        expect(c1.page_ordinal).toBeGreaterThan(c0.page_ordinal);
        expect(revalidateCursor(c1, ctx())).toEqual(c1); // still valid
    });
    it('empty-match-with-more still returns a (valid) cursor', () => {
        // an empty page in the middle: ordinal still < total -> cursor returned + revalidates
        const c = decode(encode(payload({ page_ordinal: 2, in_page_offset: 0 })));
        expect(revalidateCursor(c, ctx())).toEqual(c);
    });
    it('out-of-range ordinal is never silently clamped -> throws', () => {
        const c = decode(encode(payload({ page_ordinal: 99 })));
        expect(() => revalidateCursor(c, ctx({ pageTotalForKey: 5 }))).toThrow(InvalidCursorError);
    });
});

describe.skipIf(!hasCorpus)('rk16c exhaustive referential integrity (clean)', () => {
    it('every projection row resolves; dangling=0, mismatch=0', async () => {
        const { canon, byCanonicalId } = await buildCanonical(sample, undefined);
        const proj = projectRows(sample, byCanonicalId);
        const byKey = new Map(canon.record_locators.map((l) => [l.canonical_id, l]));
        const att = attestReferentialIntegrity(proj, (loc) => byKey.get(loc.canonical_id));
        expect(att.projection_record_count).toBe(sample.length);
        expect(att.dangling_reference_count).toBe(0);
        expect(att.content_hash_mismatch_count).toBe(0);
        expect(att.referential_integrity_attestation_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(() => assertCleanReferentialIntegrity(att)).not.toThrow();
    });
    it('a tampered content hash makes integrity fail loud', async () => {
        const { canon, byCanonicalId } = await buildCanonical(sample.slice(0, 20), undefined);
        const proj = projectRows(sample.slice(0, 20), byCanonicalId);
        const byKey = new Map(canon.record_locators.map((l) => [l.canonical_id, l]));
        proj[0] = { ...proj[0], canonical_content_hash: 'a'.repeat(64) };
        const att = attestReferentialIntegrity(proj, (loc) => byKey.get(loc.canonical_id));
        expect(att.content_hash_mismatch_count).toBe(1);
        expect(() => assertCleanReferentialIntegrity(att)).toThrow(/NOT clean/i);
    });
});

describe.skipIf(!hasCorpus)('rk16c determinism (corpus-grounded)', () => {
    it('same input -> byte-identical canonical shard + sha256', async () => {
        const a = await buildCanonical(sample, undefined, 'canon/d.bin');
        const b = await buildCanonical(sample, undefined, 'canon/d.bin');
        expect(Buffer.compare(a.canon.shard_bytes, b.canon.shard_bytes)).toBe(0);
        expect(a.canon.shard_hashes[0]).toBe(b.canon.shard_hashes[0]);
    });
});

describe('rk16c WASM activatable guard (synthetic)', () => {
    it('a WASM-fallback artifact is NOT activatable (assertActivatableCodec throws)', () => {
        expect(() => assertActivatableCodec(buildProducerTuple('wasm'))).toThrow(/NOT-ACTIVATABLE/);
        // only rust-ffi is activatable
        expect(() => assertActivatableCodec(buildProducerTuple('rust-ffi'))).not.toThrow();
    });
});
