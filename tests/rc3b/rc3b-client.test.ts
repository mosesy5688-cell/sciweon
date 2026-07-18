// @ts-nocheck
/**
 * RC-3B-P0B typed read-only client: every fail-before-network / cap / format
 * rule, each asserting the EXACT number of commands that reached the recording
 * fake (so a rejection proves ZERO/limited network, not just a thrown error).
 */
import { describe, it, expect } from 'vitest';
import { basePlan, buildClient, stdResponder } from './rc3b-fixtures';
import { makeMinimalReadOnlyS3Client } from '../../scripts/rc3b-audit/client-factory.mjs';

const MB = 1024 * 1024;

describe('RC-3B-P0B: payload / structural GET-META rules', () => {
    it('payload-class key with NO Range fails before network (0 calls)', async () => {
        const plan = basePlan({ structural_keys: ['p/data.jsonl.gz'], object_class_map: { 'p/data.jsonl.gz': 'MONOLITHIC_GZIP' } });
        const { rc, calls, budget } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.getStructuralMetadata('p/data.jsonl.gz')).rejects.toThrow(/no Range|forbidden/);
        expect(calls.length).toBe(0);
        expect(budget.counters.rejectedBeforeNetwork).toBe(1);
    });

    it('oversized GET-META is rejected AFTER HEAD and BEFORE the body GET (1 call = the HEAD)', async () => {
        const plan = basePlan({ structural_keys: ['p/big.json'] });
        const { rc, calls, budget } = buildClient(plan, { responder: stdResponder({ 'p/big.json': 2 * MB }) });
        await expect(rc.getStructuralMetadata('p/big.json')).rejects.toThrow(/get-meta object too large/);
        expect(calls.length).toBe(1);
        expect(calls[0].ctor).toBe('HeadObjectCommand');
        expect(budget.counters.headRequests).toBe(1);
        expect(budget.counters.getMetaRequests).toBe(0);
    });

    it('a non-allowlisted structural key is rejected before network (0 calls)', async () => {
        const plan = basePlan({ structural_keys: ['p/known.json'] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.getStructuralMetadata('p/unknown.json')).rejects.toThrow(/not an exact structural key/);
        expect(calls.length).toBe(0);
    });
});

describe('RC-3B-P0B: cap reached -> STOP, no network after STOP', () => {
    it('head cap STOPS the run and blocks every later call before network', async () => {
        // CLASS-C payload (MONOLITHIC_GZIP) keys, HEAD-ed via the exact HEAD family.
        const plan = basePlan({ class_c_head_keys: ['p/a.gz', 'p/b.gz'] });
        const { rc, calls, budget } = buildClient(plan, { caps: { MAX_HEAD_REQUESTS_PER_RUN: 1 }, responder: stdResponder() });
        await rc.headExactKey('p/a.gz');
        expect(calls.length).toBe(1);
        await expect(rc.headExactKey('p/b.gz')).rejects.toThrow(/head cap reached|STOPPED/);
        expect(budget.stopped).toBe(true);
        await expect(rc.headExactKey('p/a.gz')).rejects.toThrow(/STOPPED/);
        expect(calls.length).toBe(1); // no network call after STOP
    });

    it('cumulative byte cap STOPS after the first range; the second never hits network', async () => {
        const plan = basePlan({
            class_x_targets: [
                { key: 'p/s0.bin', offset: 0, length: 64, object_class: 'NXVF_SHARD' },
                { key: 'p/s1.bin', offset: 0, length: 64, object_class: 'NXVF_SHARD' },
            ],
        });
        const { rc, calls, budget } = buildClient(plan, { caps: { MAX_BYTES_TOTAL_PER_RUN: 100 }, responder: stdResponder() });
        await rc.readLocatorBoundRange('p/s0.bin', 0, 64);
        expect(calls.length).toBe(1);
        await expect(rc.readLocatorBoundRange('p/s1.bin', 0, 64)).rejects.toThrow(/cumulative byte cap/);
        expect(calls.length).toBe(1);
        expect(budget.stopped).toBe(true);
    });

    it('single Range over cap is rejected before network (0 calls)', async () => {
        const plan = basePlan({ class_x_targets: [{ key: 'p/s.bin', offset: 0, length: 70000, object_class: 'NXVF_SHARD' }] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.readLocatorBoundRange('p/s.bin', 0, 70000)).rejects.toThrow(/single range too large/);
        expect(calls.length).toBe(0);
    });

    it('LIST pagination halts exactly at the page cap', async () => {
        const plan = basePlan({ exact_prefixes: ['data/'] });
        const responder = (ctor, i) => {
            if (ctor === 'ListObjectsV2Command') return { IsTruncated: true, NextContinuationToken: 't', Contents: [{ Key: 'data/k', Size: 1, ETag: '"e"' }] };
            return {};
        };
        const { rc, calls, budget } = buildClient(plan, { caps: { MAX_LIST_PAGES_PER_RUN: 2 }, responder });
        await expect(rc.listExactPrefix('data/')).rejects.toThrow(/list-page cap reached|STOPPED/);
        expect(calls.length).toBe(2);
        expect(budget.counters.listPages).toBe(2);
    });
});

describe('RC-3B-P0B: placeholder + backup-prefix expansion rejected before network', () => {
    it('an unresolved <date> prefix is rejected (0 calls)', async () => {
        const plan = basePlan({ exact_prefixes: ['data/<date>/'] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.listExactPrefix('data/<date>/')).rejects.toThrow(/placeholder/);
        expect(calls.length).toBe(0);
    });

    it('a dynamic <backup-prefix> expansion is rejected (0 calls)', async () => {
        const plan = basePlan({ exact_prefixes: ['backups/<backup-prefix>/'] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.listExactPrefix('backups/<backup-prefix>/')).rejects.toThrow(/placeholder/);
        expect(calls.length).toBe(0);
    });

    it('a bare NNNN counter stub in a key is rejected (0 calls)', async () => {
        const plan = basePlan({ structural_keys: ['backups/db-NNNN.json'] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.getStructuralMetadata('backups/db-NNNN.json')).rejects.toThrow(/placeholder/);
        expect(calls.length).toBe(0);
    });
});

describe('RC-3B-P0B: compressed-format Range policy', () => {
    it('a Range read of a monolithic gzip object is rejected before network', async () => {
        const plan = basePlan({ class_x_targets: [{ key: 'p/x.gz', offset: 0, length: 64, object_class: 'MONOLITHIC_GZIP' }] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.readLocatorBoundRange('p/x.gz', 0, 64)).rejects.toThrow(/gzip|not seekable/);
        expect(calls.length).toBe(0);
    });

    it('a Range read of a monolithic zstd object is rejected before network', async () => {
        const plan = basePlan({ class_x_targets: [{ key: 'p/x.zst', offset: 0, length: 64, object_class: 'MONOLITHIC_ZSTD' }] });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        await expect(rc.readLocatorBoundRange('p/x.zst', 0, 64)).rejects.toThrow(/zstd|not seekable/);
        expect(calls.length).toBe(0);
    });

    it('an NXVF locator-bound Range IS accepted (exactly 1 Range GET)', async () => {
        const plan = basePlan({ class_x_targets: [{ key: 'p/s.bin', offset: 0, length: 64, object_class: 'NXVF_SHARD' }] });
        const { rc, calls, budget } = buildClient(plan, { responder: stdResponder() });
        const out = await rc.readLocatorBoundRange('p/s.bin', 0, 64);
        expect(calls.length).toBe(1);
        expect(calls[0].ctor).toBe('GetObjectCommand');
        expect(calls[0].range).toBe('bytes=0-63');
        expect(budget.counters.rangeRequests).toBe(1);
        expect(out.shape_signature_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('RC-3B-P0B: structural-class anti-spoofing (object_class_map cannot lie)', () => {
    for (const key of ['p/x.gz', 'p/x.zst', 'p/x.bin', 'p/x.dat']) {
        it(`${key} DECLARED STRUCTURAL_JSON is refused before network (0 calls)`, async () => {
            const plan = basePlan({ structural_keys: [key], object_class_map: { [key]: 'STRUCTURAL_JSON' } });
            const { rc, calls, budget } = buildClient(plan, { responder: stdResponder() });
            await expect(rc.getStructuralMetadata(key)).rejects.toThrow(/FORMAT_NOT_SEEKABLE|spoof|structural|forbidden/);
            expect(calls.length).toBe(0);
            expect(budget.counters.rejectedBeforeNetwork).toBe(1);
        });
    }

    it('a real manifest.json is accepted: exactly HEAD + one GET', async () => {
        const plan = basePlan({ structural_keys: ['p/manifest.json'], object_class_map: { 'p/manifest.json': 'STRUCTURAL_JSON' } });
        const { rc, calls } = buildClient(plan, { responder: stdResponder() });
        const out = await rc.getStructuralMetadata('p/manifest.json');
        expect(calls.map((c) => c.ctor)).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
        expect(out.object_class).toBe('STRUCTURAL_JSON');
    });
});

describe('RC-3B-P0B: exact LIST-key cap (clamp MaxKeys, stop at the exact budget)', () => {
    const truncating = (ctor, i) => {
        if (ctor === 'ListObjectsV2Command') {
            const contents = Array.from({ length: i.MaxKeys }, (_, n) => ({ Key: `data/k${n}`, Size: 1, ETag: '"e"' }));
            return { IsTruncated: true, NextContinuationToken: 't', Contents: contents };
        }
        return {};
    };

    it('MAX_LIST_KEYS_PER_RUN=1 clamps MaxKeys to 1 and stops after 1 key', async () => {
        const plan = basePlan({ exact_prefixes: ['data/'] });
        const { rc, calls, budget } = buildClient(plan, { caps: { MAX_LIST_KEYS_PER_RUN: 1 }, responder: truncating });
        const r = await rc.listExactPrefix('data/');
        expect(r.keys.length).toBe(1);
        expect(calls.length).toBe(1);
        expect(calls[0].maxKeys).toBe(1);
        expect(budget.stopped).toBe(true);
    });

    it('MAX_LIST_KEYS_PER_RUN=10 clamps MaxKeys to 10 and stops at 10 keys', async () => {
        const plan = basePlan({ exact_prefixes: ['data/'] });
        const { rc, calls, budget } = buildClient(plan, { caps: { MAX_LIST_KEYS_PER_RUN: 10 }, responder: truncating });
        const r = await rc.listExactPrefix('data/');
        expect(r.keys.length).toBe(10);
        expect(calls[0].maxKeys).toBe(10);
        expect(budget.stopped).toBe(true);
    });

    it('a provider returning MORE than requested MaxKeys -> INTEGRITY_ANOMALY, keys NOT emitted, STOPPED', async () => {
        const plan = basePlan({ exact_prefixes: ['data/'] });
        const overReturn = (ctor, i) => {
            if (ctor === 'ListObjectsV2Command') {
                const contents = Array.from({ length: i.MaxKeys + 1 }, (_, n) => ({ Key: `data/k${n}`, Size: 1, ETag: '"e"' }));
                return { IsTruncated: true, NextContinuationToken: 't', Contents: contents };
            }
            return {};
        };
        const { rc, calls, budget } = buildClient(plan, { responder: overReturn });
        await expect(rc.listExactPrefix('data/')).rejects.toThrow(/INTEGRITY_ANOMALY|more keys/);
        expect(calls.length).toBe(1);
        expect(budget.stopped).toBe(true);
        expect(budget.counters.listKeys).toBe(0); // none emitted
    });
});

describe('RC-3B-P0B-C4-E-T1: minimal client factory REQUIRES a temporary session token (no fallback)', () => {
    const TRIO = { R2_ACCOUNT_ID: 'synthetic-account', R2_ACCESS_KEY_ID: 'synthetic-access-key', R2_SECRET_ACCESS_KEY: 'synthetic-secret-key' };
    const VALID = Buffer.from('jwt/aaa.bbb.ccc').toString('base64');

    it('a valid trio + valid session token builds a client with the token BYTE-EXACT in credentials (item b)', async () => {
        const client = makeMinimalReadOnlyS3Client({ ...TRIO, R2_SESSION_TOKEN: VALID });
        expect(client).toBeTruthy();
        const creds = await client.config.credentials();
        expect(creds.sessionToken).toBe(VALID);
        expect(creds.accessKeyId).toBe('synthetic-access-key');
        expect(creds.secretAccessKey).toBe('synthetic-secret-key');
    });

    it('a 3-field-only env (NO session token) THROWS -- no fallback, no client (item c)', () => {
        expect(() => makeMinimalReadOnlyS3Client({ ...TRIO })).toThrow(/SESSION_TOKEN_INVALID: MISSING/);
    });

    it('a valid trio + an INVALID session token THROWS (no client, no token bytes)', () => {
        expect(() => makeMinimalReadOnlyS3Client({ ...TRIO, R2_SESSION_TOKEN: 'notbase64$$$' })).toThrow(/SESSION_TOKEN_INVALID/);
    });

    it('a fully-absent env returns null (inert path preserved; item c)', () => {
        expect(makeMinimalReadOnlyS3Client({})).toBe(null);
    });

    it('a partial trio THROWS CREDENTIAL_INCOMPLETE (no fallback, before any token consumption)', () => {
        expect(() => makeMinimalReadOnlyS3Client({ R2_ACCOUNT_ID: 'synthetic-account' })).toThrow(/CREDENTIAL_INCOMPLETE/);
    });
});
