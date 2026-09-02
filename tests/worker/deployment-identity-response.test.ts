/**
 * P0.2 deployment identity -- the `_health` RESPONSE contract (brief section 4
 * tests 3-7, plus the frozen corrections).
 *
 * Every assertion here runs through `handleHealth`, so the single shared
 * Response constructor is what is under test: HTTP 200, `Cache-Control:
 * no-store` and exactly the eight keys of section 3d, on the `available` path
 * AND on each of the five unavailable reasons -- six paths in all.
 */

import { describe, it, expect } from 'vitest';
import { handleHealth } from '../../src/worker/api/health';

const VALID_SHA = 'c88c1f525d623f0b3a16715551d3a5983438e36a';
const UPPER_SHA = VALID_SHA.toUpperCase();
const ID = 'abcdef12-3456-7890';
const TS = '2026-09-02T00:00:00.000Z';

// The eight keys of section 3d, in the order the response emits them.
const KEYS_3D = [
    'status', 'r2_binding', 'timestamp', 'deployment_identity_status',
    'git_sha', 'worker_version_id', 'worker_version_timestamp',
    'deployment_identity_reason',
];

// The same eight names written out SORTED. This literal is the deep-equality
// target: a constructor that silently dropped `timestamp` would still pass a
// cross-case stability check, so stability alone is not enough.
const KEYS_SORTED = [
    'deployment_identity_reason', 'deployment_identity_status', 'git_sha',
    'r2_binding', 'status', 'timestamp', 'worker_version_id',
    'worker_version_timestamp',
];

function readFailBinding(): unknown {
    return { get tag(): never { throw new Error(); }, id: ID, timestamp: TS };
}

interface Path { name: string; reason: string | null; binding: unknown }

const PATHS: Path[] = [
    { name: 'available', reason: null, binding: { tag: VALID_SHA, id: ID, timestamp: TS } },
    { name: 'binding_read_failed', reason: 'binding_read_failed', binding: readFailBinding() },
    { name: 'binding_absent', reason: 'binding_absent', binding: undefined },
    { name: 'tag_absent', reason: 'tag_absent', binding: { id: ID, timestamp: TS } },
    { name: 'tag_empty', reason: 'tag_empty', binding: { tag: '', id: ID, timestamp: TS } },
    { name: 'tag_not_40_lowercase_hex', reason: 'tag_not_40_lowercase_hex',
      binding: { tag: UPPER_SHA, id: ID, timestamp: TS } },
];

function envWith(binding: unknown, r2?: unknown): any {
    return { ASSETS: {}, SCIWEON_R2: r2, CF_VERSION_METADATA: binding };
}

const REQ = () => new Request('https://sciweon.com/api/v1/_health');
const CTX = {} as any;

async function call(env: any) {
    const res = await handleHealth(REQ(), env, CTX);
    const text = await res.text();
    return { res, text, body: JSON.parse(text) };
}

describe('_health -- the eight-key literal is itself correct', () => {
    it('KEYS_3D has eight names and sorts to KEYS_SORTED', () => {
        expect(KEYS_3D).toHaveLength(8);
        expect(KEYS_SORTED).toHaveLength(8);
        expect(KEYS_3D.slice().sort()).toEqual(KEYS_SORTED);
    });
});

describe('_health -- all six paths (available + five unavailable reasons)', () => {
    for (const p of PATHS) {
        it(`${p.name}: HTTP 200 and Cache-Control: no-store`, async () => {
            const { res } = await call(envWith(p.binding));
            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toBe('no-store');
        });

        it(`${p.name}: status is "ok" and timestamp parses`, async () => {
            const { body } = await call(envWith(p.binding));
            expect(body.status).toBe('ok');
            expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true);
        });

        it(`${p.name}: reports the expected reason and status`, async () => {
            const { body } = await call(envWith(p.binding));
            expect(body.deployment_identity_reason).toBe(p.reason);
            expect(body.deployment_identity_status).toBe(p.reason === null ? 'available' : 'unavailable');
        });

        it(`${p.name}: key set is EXACTLY the eight of section 3d`, async () => {
            const { text } = await call(envWith(p.binding));
            expect(Object.keys(JSON.parse(text)).sort()).toEqual(KEYS_SORTED);
        });

        it(`${p.name}: carries no version key`, async () => {
            const { body } = await call(envWith(p.binding));
            expect(Object.prototype.hasOwnProperty.call(body, 'version')).toBe(false);
        });
    }

    it('the sorted key set is byte-identical across every path', async () => {
        const seen: string[] = [];
        for (const p of PATHS) {
            const { text } = await call(envWith(p.binding));
            seen.push(JSON.stringify(Object.keys(JSON.parse(text)).sort()));
        }
        expect(seen).toHaveLength(6);
        expect(new Set(seen).size).toBe(1);
        expect(JSON.parse(seen[0])).toEqual(KEYS_SORTED);
    });
});

describe('_health -- r2_binding truthfulness (brief test 4)', () => {
    it('is true when R2 is bound on the binding_read_failed path', async () => {
        const { body } = await call(envWith(readFailBinding(), { fake: 'bucket' }));
        expect(body.r2_binding).toBe(true);
    });

    it('is false when R2 is not bound on the binding_read_failed path', async () => {
        const { body } = await call(envWith(readFailBinding(), undefined));
        expect(body.r2_binding).toBe(false);
    });

    it('tracks R2 independently of every identity field', async () => {
        const bound = await call(envWith({ tag: VALID_SHA }, { fake: 'bucket' }));
        const unbound = await call(envWith({ tag: VALID_SHA }, undefined));
        expect(bound.body.r2_binding).toBe(true);
        expect(unbound.body.r2_binding).toBe(false);
        expect(bound.body.git_sha).toBe(VALID_SHA);
        expect(unbound.body.git_sha).toBe(VALID_SHA);
        expect(bound.body.deployment_identity_status).toBe('available');
        expect(unbound.body.deployment_identity_status).toBe('available');
    });
});

describe('_health -- handler guards never relabel and never 500', () => {
    it('an env whose SCIWEON_R2 access throws: 200, r2_binding false, TAG-derived reason', async () => {
        const env: any = {
            ASSETS: {},
            CF_VERSION_METADATA: { tag: UPPER_SHA, id: ID, timestamp: TS },
            get SCIWEON_R2(): never { throw new Error(); },
        };
        const { res, body } = await call(env);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(body.r2_binding).toBe(false);
        expect(body.deployment_identity_reason).toBe('tag_not_40_lowercase_hex');
        expect(body.deployment_identity_status).toBe('unavailable');
    });

    it('an env whose CF_VERSION_METADATA access throws reports binding_read_failed at 200', async () => {
        const env: any = {
            ASSETS: {},
            SCIWEON_R2: { fake: 'bucket' },
            get CF_VERSION_METADATA(): never { throw new Error(); },
        };
        const { res, body } = await call(env);
        expect(res.status).toBe(200);
        expect(body.deployment_identity_reason).toBe('binding_read_failed');
        expect(body.r2_binding).toBe(true);
        expect(Object.keys(body).sort()).toEqual(KEYS_SORTED);
    });

    it('never throws, always 200 (brief test 5)', async () => {
        const envs: any[] = [
            envWith(undefined), envWith(null), envWith(readFailBinding()),
            envWith({ get id(): never { throw new Error(); }, tag: VALID_SHA }),
            {},
        ];
        for (const e of envs) {
            const res = await handleHealth(REQ(), e, CTX);
            expect(res.status).toBe(200);
        }
    });
});

describe('_health -- no fabrication (brief test 6)', () => {
    // Known-POSITIVE control first: the scan CAN see a 40-hex run when one is
    // genuinely present. Without it a broken scanner would "pass" the negative.
    it('the scan detects the real SHA on the available path', async () => {
        const { text, body } = await call(envWith({ tag: VALID_SHA, id: ID, timestamp: TS }));
        expect(text).toMatch(/[0-9a-fA-F]{40}/);
        expect(body.git_sha).toBe(VALID_SHA);
    });

    it('an invalid tag leaves git_sha null and no 40-char hex-looking value in the body', async () => {
        const { text, body } = await call(envWith({ tag: UPPER_SHA, id: ID, timestamp: TS }));
        expect(body.git_sha).toBeNull();
        expect(text).not.toMatch(/[0-9a-fA-F]{40}/);
        expect(text).not.toContain(UPPER_SHA);
    });

    it('emits git_sha verbatim, and worker_version_id independently', async () => {
        const { body } = await call(envWith({ tag: VALID_SHA, id: ID, timestamp: TS }));
        expect(body.git_sha).toBe(VALID_SHA);
        expect(body.worker_version_id).toBe(ID);
        expect(body.worker_version_timestamp).toBe(TS);
    });
});
