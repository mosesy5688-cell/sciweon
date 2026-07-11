// @ts-nocheck
/**
 * RC-3B-P0B bounded response-body collector + Content-Range verification. Unit
 * coverage for collectBounded / verifyContentRange, then the section-6 client
 * cases: an over-read (GET-META body != HEAD size, Range body > requested), a
 * missing/wrong/covering Content-Range, and an incrementally oversize stream all
 * STOP the run and NEVER hash a body into evidence; the byte counters record
 * ACTUAL bytes received on the success path.
 */
import { describe, it, expect } from 'vitest';
import { collectBounded, ResponseBoundExceeded, verifyContentRange } from '../../scripts/rc3b-audit/bounded-collector.mjs';
import { basePlan, buildClient } from './rc3b-fixtures';

async function* byteStream(total) { for (let n = 0; n < total; n += 1) yield Buffer.from([1]); }

describe('RC-3B-P0B collectBounded', () => {
    it('returns a Buffer at/under the limit', async () => {
        expect((await collectBounded(Buffer.alloc(64, 1), 64)).length).toBe(64);
        expect((await collectBounded('hello', 10)).length).toBe(5);
        expect((await collectBounded(await bufFromStream(10), 10)).length).toBe(10);
    });
    it('throws ResponseBoundExceeded when a Buffer exceeds the limit', async () => {
        await expect(collectBounded(Buffer.alloc(65, 1), 64)).rejects.toBeInstanceOf(ResponseBoundExceeded);
    });
    it('aborts an incrementally oversize stream at limit+1', async () => {
        await expect(collectBounded(byteStream(65), 64)).rejects.toBeInstanceOf(ResponseBoundExceeded);
    });
});

async function bufFromStream(total) { const c = []; for await (const b of byteStream(total)) c.push(b); return Buffer.concat(c); }

describe('RC-3B-P0B verifyContentRange', () => {
    it('accepts an exact range and rejects missing / wrong / covering / non-integer total', () => {
        expect(verifyContentRange('bytes 0-63/4096', 0, 64)).toBe(true);
        expect(verifyContentRange(undefined, 0, 64)).toBe(false);
        expect(verifyContentRange('bytes 0-100/4096', 0, 64)).toBe(false);
        expect(verifyContentRange('bytes 0-4095/4096', 0, 64)).toBe(false);
        expect(verifyContentRange('bytes 0-63/*', 0, 64)).toBe(false);
    });
});

const RANGE_PLAN = () => basePlan({ class_x_targets: [{ key: 'p/s.bin', offset: 0, length: 64, object_class: 'NXVF_SHARD' }] });
const META_PLAN = () => basePlan({ structural_keys: ['p/m.json'], object_class_map: { 'p/m.json': 'STRUCTURAL_JSON' } });
const shard = (n) => Buffer.concat([Buffer.from([0x4e, 0x58, 0x56, 0x46]), Buffer.alloc(Math.max(0, n - 4), 1)]);

describe('RC-3B-P0B bounded Range: STOP + no body hashed', () => {
    it('provider returns 65 bytes for a 64-byte Range -> INTEGRITY_ANOMALY / STOP', async () => {
        const responder = (ctor) => (ctor === 'GetObjectCommand' ? { ETag: '"e"', ContentRange: 'bytes 0-63/4096', Body: shard(65) } : {});
        const { rc, calls, budget } = buildClient(RANGE_PLAN(), { responder });
        await expect(rc.readLocatorBoundRange('p/s.bin', 0, 64)).rejects.toThrow(/INTEGRITY_ANOMALY|exceeded/);
        expect(budget.stopped).toBe(true); expect(calls.length).toBe(1);
    });
    it('provider returns the FULL object (covering Content-Range) -> STOP', async () => {
        const responder = (ctor) => (ctor === 'GetObjectCommand' ? { ETag: '"e"', ContentRange: 'bytes 0-4095/4096', Body: shard(64) } : {});
        const { rc, calls, budget } = buildClient(RANGE_PLAN(), { responder });
        await expect(rc.readLocatorBoundRange('p/s.bin', 0, 64)).rejects.toThrow(/INTEGRITY_ANOMALY|Content-Range/);
        expect(budget.stopped).toBe(true); expect(calls.length).toBe(1);
    });
    it('a WRONG Content-Range -> STOP', async () => {
        const responder = (ctor) => (ctor === 'GetObjectCommand' ? { ETag: '"e"', ContentRange: 'bytes 0-100/4096', Body: shard(64) } : {});
        const { rc, budget } = buildClient(RANGE_PLAN(), { responder });
        await expect(rc.readLocatorBoundRange('p/s.bin', 0, 64)).rejects.toThrow(/INTEGRITY_ANOMALY|Content-Range/);
        expect(budget.stopped).toBe(true);
    });
    it('a MISSING Content-Range -> STOP', async () => {
        const responder = (ctor) => (ctor === 'GetObjectCommand' ? { ETag: '"e"', Body: shard(64) } : {});
        const { rc, budget } = buildClient(RANGE_PLAN(), { responder });
        await expect(rc.readLocatorBoundRange('p/s.bin', 0, 64)).rejects.toThrow(/INTEGRITY_ANOMALY|Content-Range/);
        expect(budget.stopped).toBe(true);
    });
});

describe('RC-3B-P0B bounded GET-META: STOP + no body hashed', () => {
    it('HEAD=100 body=101 -> INTEGRITY_ANOMALY / STOP (2 calls: HEAD+GET)', async () => {
        const responder = (ctor) => (ctor === 'HeadObjectCommand' ? { ETag: '"e"', ContentLength: 100 } : { ETag: '"e"', Body: Buffer.alloc(101, 1) });
        const { rc, calls, budget } = buildClient(META_PLAN(), { responder });
        await expect(rc.getStructuralMetadata('p/m.json')).rejects.toThrow(/INTEGRITY_ANOMALY|exceeded/);
        expect(budget.stopped).toBe(true); expect(calls.length).toBe(2);
    });
    it('HEAD=100 body=99 (actual != expected) -> INTEGRITY_ANOMALY / STOP', async () => {
        const responder = (ctor) => (ctor === 'HeadObjectCommand' ? { ETag: '"e"', ContentLength: 100 } : { ETag: '"e"', Body: Buffer.alloc(99, 1) });
        const { rc, budget } = buildClient(META_PLAN(), { responder });
        await expect(rc.getStructuralMetadata('p/m.json')).rejects.toThrow(/INTEGRITY_ANOMALY|expected/);
        expect(budget.stopped).toBe(true);
    });
});

describe('RC-3B-P0B bounded: counters record ACTUAL bytes on success', () => {
    it('GET-META bytes_get_meta == the received body length', async () => {
        const body = Buffer.from('{"a":1}');
        const responder = (ctor) => (ctor === 'HeadObjectCommand' ? { ETag: '"e"', ContentLength: body.length } : { ETag: '"e"', Body: body });
        const { rc, budget } = buildClient(META_PLAN(), { responder });
        await rc.getStructuralMetadata('p/m.json');
        expect(budget.counters.bytesGetMeta).toBe(body.length);
    });
    it('Range bytes_range == the received body length', async () => {
        const responder = (ctor) => (ctor === 'GetObjectCommand' ? { ETag: '"e"', ContentRange: 'bytes 0-63/4096', ContentLength: 64, Body: shard(64) } : {});
        const { rc, budget } = buildClient(RANGE_PLAN(), { responder });
        await rc.readLocatorBoundRange('p/s.bin', 0, 64);
        expect(budget.counters.bytesRange).toBe(64);
    });
});
