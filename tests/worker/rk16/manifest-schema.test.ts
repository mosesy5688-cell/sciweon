/**
 * RK-16A1 — manifest schema validators: crypto_mode locked to passthrough_v1;
 * non-throwing { ok, errors[] } shape; required fields enforced.
 */
import { describe, it, expect } from 'vitest';
import {
    validateFamilyManifest, validateProducerTuple, validatePageSizePolicy,
    CRYPTO_MODE_PASSTHROUGH,
} from '../../../src/worker/lib/rk16/manifest-schema';

const producer = {
    codec_name: 'zstd', codec_impl: 'fzstd', codec_version: '0.1.1', codec_level: 19,
    dictionary_hash: null, crypto_mode: CRYPTO_MODE_PASSTHROUGH,
    record_serialization: 'json', serialization_version: '1', sort_order: 'canonical_id_asc',
};
const pageSize = { record_count_target: 1000, compressed_bytes_ceiling: 1048576, parsed_heap_ceiling: 4194304 };
const manifest = {
    family_id: 'fam', bucket: 'b', object_prefix: 'snapshots/x/', snapshot_id: 'x',
    layout_version: 'immutable_snapshot_v2', schema_version: 1, shard_hashes: ['h0', 'h1'],
    record_total: 10, page_total: 2, index_key_total: 3,
    page_size_policy: pageSize, producer_tuple: producer,
};

describe('RK-16A1 manifest-schema — validators return { ok, errors[] } (no throw)', () => {
    it('a complete manifest validates ok with no errors', () => {
        const r = validateFamilyManifest(manifest);
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
    });

    it('optional referential_integrity_attestation_hash is accepted', () => {
        expect(validateFamilyManifest({ ...manifest, referential_integrity_attestation_hash: 'a' }).ok).toBe(true);
    });

    it('crypto_mode must be the literal passthrough_v1', () => {
        const r = validateProducerTuple({ ...producer, crypto_mode: 'aes256' });
        expect(r.ok).toBe(false);
        expect(r.errors.some(e => e.includes('passthrough_v1'))).toBe(true);
    });

    it('missing required fields are reported, not thrown', () => {
        const r = validateFamilyManifest({ ...manifest, family_id: '', shard_hashes: 'x' });
        expect(r.ok).toBe(false);
        expect(r.errors.length).toBeGreaterThan(0);
    });

    it('page-size policy requires non-negative integers', () => {
        expect(validatePageSizePolicy({ ...pageSize, parsed_heap_ceiling: -1 }).ok).toBe(false);
    });
});
