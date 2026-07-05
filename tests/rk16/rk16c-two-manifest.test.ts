// @ts-nocheck
/**
 * RK-16C D-120 A1 TWO-MANIFEST PREFLIGHT - corrected trust model tests.
 * Root seal = identity/object_prefix/manifest_hash ONLY (does NOT attest the
 * payload); payload MEMBERSHIP = producer required-satellite SSoT; payload PIN =
 * sibling manifest.files[]. Fixtures DEFAULT to production-faithful (payload absent
 * from BOTH seal fields). ZERO network (fake client only). Covers all 13 cases +
 * the FALSE-GREEN guard + retained legacy negatives.
 */
import { describe, it, expect } from 'vitest';
import {
    deriveObjectPrefix, deriveFileManifestKey, validateRootSeal, validateFileManifest,
    assertPayloadIsRequiredSatellite, extractPayloadPin, payloadRelativeFilename,
    TRUST_ANCHOR_MODE, PAYLOAD_MEMBERSHIP_AUTHORITY, PAYLOAD_PIN_AUTHORITY,
} from '../../scripts/spikes/rk16c/lib/two-manifest-preflight.mjs';
import { preflightManifest } from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import { validateLock } from '../../scripts/spikes/rk16c/lib/fullcorpus-lock.mjs';
import { requiredSatelliteKeys } from '../../scripts/factory/lib/snapshot-inventory.js';
import {
    SNAP, PREFIX, SEAL_KEY, FILE_KEY, PAYLOAD_KEY, BIO,
    sealObj, fileManifestObj, buf, goodBodies, fakeDeps,
} from './rk16c-two-manifest-fixtures';

const REQ = requiredSatelliteKeys(PREFIX); // the real, frozen producer SSoT for this prefix
const preflight = (deps, opts = {}) =>
    preflightManifest({ execute: true, snapshot: SNAP, manifestKey: SEAL_KEY, ...opts }, deps);

describe('D-120 A1 - production-faithful PASS + FALSE-GREEN guard (case 1)', () => {
    it('payload absent from BOTH seal fields, in SSoT, in sibling -> PASS with SIBLING pins', async () => {
        const seal = sealObj();
        expect(seal.satellite_inventory).toEqual([]);                 // false-green: NEITHER seal field...
        expect(seal.satellite_inventory).not.toContain(PAYLOAD_KEY);
        expect(seal.required_inventory).not.toContain(PAYLOAD_KEY);
        expect(REQ).toContain(PAYLOAD_KEY);                           // ...membership decided by the SSoT
        const { seen, deps } = fakeDeps(goodBodies());
        const r = await preflight(deps, { expectedRows: 475112 });
        expect(r.candidate.payload_sha256_compressed).toBe('b'.repeat(64)); // FROM the sibling files[]
        expect(r.candidate.payload_compressed_bytes).toBe(62914560);
        expect(r.candidate.expected_row_count).toBe(475112);
        expect(seen.some((s) => s.key === PAYLOAD_KEY)).toBe(false);
    });
});

describe('D-120 A1 - SSoT membership authority (cases 2,3)', () => {
    it('case 2 - non-member payload filename FAILS CLOSED (even if present in the sibling)', () => {
        const nonMember = PREFIX + 'not-a-member.jsonl.gz';
        expect(REQ).not.toContain(nonMember);
        expect(() => assertPayloadIsRequiredSatellite(REQ, nonMember)).toThrow(/absent from required-satellite contract/);
    });
    it('case 3 - DUPLICATED in the SSoT list FAILS CLOSED (injected dup; real constant is frozen+unique)', () => {
        expect(() => assertPayloadIsRequiredSatellite([PAYLOAD_KEY, PAYLOAD_KEY], PAYLOAD_KEY)).toThrow(/duplicated/);
        expect(REQ.filter((k) => k === PAYLOAD_KEY).length).toBe(1);
    });
});

describe('D-120 A1 - sibling manifest.files[] pin authority (cases 4,5 + corrupt pins)', () => {
    it('case 4 - payload in SSoT but ABSENT from the sibling files[] -> FAIL CLOSED', async () => {
        const { deps } = fakeDeps(goodBodies(undefined, { files: [
            { filename: 'papers.jsonl.gz', compressed_bytes: 1, sha256_compressed: 'c'.repeat(64) },
        ] }));
        await expect(preflight(deps)).rejects.toThrow(/absent from sibling manifest\.files/);
    });
    it('case 5 - payload DUPLICATED in the sibling files[] FAILS CLOSED (payload-scoped exactly-once)', () => {
        const dup = [
            { filename: BIO, compressed_bytes: 9, sha256_compressed: 'b'.repeat(64) },
            { filename: BIO, compressed_bytes: 9, sha256_compressed: 'b'.repeat(64) },
        ];
        expect(() => extractPayloadPin(dup, BIO)).toThrow(/duplicated/);
    });
    it('case 5 (end-to-end) - a duplicate files[] filename is rejected by validateFileManifest', async () => {
        const { deps } = fakeDeps(goodBodies(undefined, { files: [
            { filename: BIO, compressed_bytes: 9, sha256_compressed: 'b'.repeat(64) },
            { filename: BIO, compressed_bytes: 9, sha256_compressed: 'b'.repeat(64) },
        ] }));
        await expect(preflight(deps)).rejects.toThrow(/duplicate files\[\] filename/);
    });
    it('legacy - present-but-corrupt payload pins FAIL CLOSED (invalid sha256 / bytes)', () => {
        expect(() => extractPayloadPin([{ filename: BIO, compressed_bytes: 9, sha256_compressed: 'nothex' }], BIO)).toThrow(/sha256_compressed invalid/);
        expect(() => extractPayloadPin([{ filename: BIO, compressed_bytes: 0, sha256_compressed: 'b'.repeat(64) }], BIO)).toThrow(/compressed_bytes invalid/);
    });
});

describe('D-120 A1 - sibling-key derivation + prefix binding (cases 6,7,8)', () => {
    it('the sibling key derives from the validated prefix; a different prefix cannot re-point it', () => {
        expect(deriveObjectPrefix(SNAP)).toBe(PREFIX);
        expect(deriveFileManifestKey(PREFIX)).toBe(FILE_KEY);
        expect(deriveFileManifestKey('snapshots/other/9-1/')).not.toBe(FILE_KEY);
        expect(() => deriveFileManifestKey('snapshots/x')).toThrow(/object_prefix must end/);
    });
    it('case 6 - a seal whose object_prefix cannot be validated FAILS BEFORE the 2nd read (sibling never read)', async () => {
        const { seen, deps } = fakeDeps(goodBodies({ object_prefix: 'snapshots/2026-06-14/OTHER-1/' }));
        await expect(preflight(deps)).rejects.toThrow(/object_prefix mismatch/);
        expect(seen.every((s) => s.key === SEAL_KEY)).toBe(true); // manifest.json never reached
    });
    it('case 7 - a payload key OUTSIDE the snapshot prefix FAILS CLOSED', () => {
        expect(() => payloadRelativeFilename('snapshots/OTHER/1-1/bioactivities.jsonl.gz', PREFIX)).toThrow(/escapes validated object_prefix/);
        expect(payloadRelativeFilename(PAYLOAD_KEY, PREFIX)).toBe(BIO);
    });
    it('case 8 - root object_prefix mismatch FAILS CLOSED (validateRootSeal)', () => {
        expect(() => validateRootSeal(buf(sealObj({ object_prefix: 'snapshots/2026-06-14/OTHER-1/' })), { snapshotId: SNAP })).toThrow(/object_prefix mismatch/);
    });
});

describe('D-120 A1 - seal is identity/hash/compat only (case 9 + legacy)', () => {
    it('valid seal -> facts (identity + recomputed hash); does NOT require the payload in any seal field', () => {
        const f = validateRootSeal(buf(sealObj()), { snapshotId: SNAP });
        expect(f.object_prefix).toBe(PREFIX);
        expect(f.production_run_id).toBe('27502029137-1');
        expect(f.stored_hash).toBe(f.recomputed_hash);
        expect(f.satellite_inventory).toEqual([]); // audit-only
    });
    it('case 9 - manifest_hash mismatch FAILS CLOSED', () => {
        expect(() => validateRootSeal(buf(sealObj({ badHash: true })), { snapshotId: SNAP })).toThrow(/manifest_hash mismatch/);
    });
    it('case 9 - missing layout/schema FAILS CLOSED', () => {
        const s = sealObj(); delete s.layout_version;
        expect(() => validateRootSeal(buf(s), { snapshotId: SNAP })).toThrow(/missing layout_version/);
    });
    it('legacy - seal snapshot_id mismatch FAILS CLOSED (never auto-switch)', () => {
        expect(() => validateRootSeal(buf(sealObj({ snapshot_id: 'other/9-1' })), { snapshotId: SNAP })).toThrow(/snapshot_id mismatch/);
    });
    it('legacy - a files[] filename path-escape (../) FAILS CLOSED', () => {
        expect(() => validateFileManifest(buf(fileManifestObj({ files: [{ filename: '../evil.gz', compressed_bytes: 1, sha256_compressed: 'b'.repeat(64) }] })), { snapshotId: SNAP, objectPrefix: PREFIX }))
            .toThrow(/escapes validated object_prefix|not a bare name/);
    });
});

describe('D-120 A1 - adapter read-path invariants (cases 10,11,12)', () => {
    it('reads EXACTLY seal then sibling manifest; NO payload, NO latest, NO List/Write/Delete', async () => {
        const { seen, deps } = fakeDeps(goodBodies());
        await preflight(deps);
        expect(seen).toEqual([
            { ctor: 'HeadObjectCommand', key: SEAL_KEY },
            { ctor: 'GetObjectCommand', key: SEAL_KEY },
            { ctor: 'HeadObjectCommand', key: FILE_KEY },
            { ctor: 'GetObjectCommand', key: FILE_KEY },
        ]);
        expect(seen.some((s) => s.key === PAYLOAD_KEY)).toBe(false);              // case 11
        expect(seen.some((s) => s.key === 'snapshots/latest.json')).toBe(false);  // case 10
        expect(seen.some((s) => /^(List|Put|Delete|Copy)/.test(s.ctor))).toBe(false); // case 12
    });
    it('case 10 - latest.json is rejected as the manifest-key', async () => {
        await expect(preflightManifest({ execute: true, snapshot: SNAP, manifestKey: 'snapshots/latest.json' }, fakeDeps(goodBodies()).deps))
            .rejects.toThrow(/manifest-key mismatch/);
    });
    it('case 11 - the payload key is returned but NEVER allowlisted / read', async () => {
        const { deps } = fakeDeps(goodBodies());
        const r = await preflight(deps);
        expect(r.payload_key).toBe(PAYLOAD_KEY);
        expect(r.candidate.authorized_for_payload_read).toBeUndefined();
    });
});

describe('D-120 A1 - candidate-lock trust fields (case 13)', () => {
    it('records the corrected trust model + is a structurally complete v2 lock', async () => {
        const { deps } = fakeDeps(goodBodies());
        const r = await preflight(deps);
        expect(r.candidate.trust_anchor_mode).toBe(TRUST_ANCHOR_MODE);
        expect(r.candidate.root_directly_references_file_manifest).toBe(false);
        expect(r.candidate.payload_membership_authority).toBe(PAYLOAD_MEMBERSHIP_AUTHORITY);
        expect(r.candidate.payload_pin_authority).toBe(PAYLOAD_PIN_AUTHORITY);
        expect(PAYLOAD_MEMBERSHIP_AUTHORITY).toBe('required_satellite_ssot');
        expect(PAYLOAD_PIN_AUTHORITY).toBe('sibling_manifest_files');
        const json = JSON.stringify(r.candidate).toLowerCase();
        expect(json).not.toContain('cryptograph');
        expect(json).not.toContain('root-sealed');
        expect(validateLock(r.candidate).ok).toBe(true);
    });
});
