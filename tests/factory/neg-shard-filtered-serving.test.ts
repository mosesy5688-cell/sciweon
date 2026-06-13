// @ts-nocheck
/**
 * REQUIRED CI GATE — event_type-FILTERED serving on the sharded path (PM-found
 * re-review fix #7). The prior sharded path shaped the response with the
 * UNFILTERED total + UNFILTERED pagination, then post-shape filtered only the
 * returned `signals` -> a FALSE count + a non-paginable filtered set on the
 * SAFETY endpoint. This publishes a synthetic compound (2 evidence_types over
 * >=2 pages) through the REAL publisher + serves it through the REAL worker
 * loader, asserting the filtered count/aggregates/pagination AND sharded ==
 * legacy parity for the same fixture.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { publishNegShards } from '../../scripts/factory/lib/neg-shard-publisher.js';
import { loadNegEvidenceForCompound, DEFAULT_PAGE_LIMIT } from '../../src/worker/lib/neg-evidence-loader';
import { parseEventTypeFilter } from '../../src/worker/lib/event-type-taxonomy';

const COMPOUND = 'sciweon::compound::CID:2244';
const DATE = '2026-06-05';
const BASE = 'https://sciweon.com';

// neg-manifest-loader uses the Cloudflare Cache API (`caches.default`). Node has
// no `caches` global -> install a no-op (always-miss) shim so the loader falls
// through to the R2 GET path under test. (The Worker runtime provides the real one.)
beforeAll(() => {
    if (typeof (globalThis as any).caches === 'undefined') {
        (globalThis as any).caches = { default: { async match() { return undefined; }, async put() { } } };
    }
});

// 80 trial_failure (alternating critical/major) + 40 black_box_warning
// (alternating critical/minor), INTERLEAVED so each page (NEG_PAGE_SIZE=64, ->
// 2 pages for 120) mixes both types -> exercises cross-page filtered paging.
function buildFixture() {
    const lines = [];
    const counts = { trial_failure: 0, black_box_warning: 0 };
    let tf = 0, bb = 0;
    for (let i = 0; i < 120; i++) {
        if (i % 3 !== 2) { // 2 of 3 -> trial_failure (80), rest bb (40)
            lines.push(JSON.stringify({
                id: `sciweon::neg::trial_failure::T${String(10000 + tf).padStart(6, '0')}`,
                evidence_type: 'trial_failure', subject: { compound_id: COMPOUND },
                severity: tf % 2 === 0 ? 'critical' : 'major', failure: { reason_category: 'SAFETY' },
            }));
            counts.trial_failure++; tf++;
        } else {
            lines.push(JSON.stringify({
                id: `sciweon::neg::black_box_warning::B${String(20000 + bb).padStart(6, '0')}`,
                evidence_type: 'black_box_warning', subject: { compound_id: COMPOUND },
                severity: bb % 2 === 0 ? 'critical' : 'minor', failure: { reason_category: 'OTHER' },
            }));
            counts.black_box_warning++; bb++;
        }
    }
    return { lines, counts };
}

// One in-memory store acting as BOTH the publisher's S3 client (PutObject) and
// the worker's R2Bucket (head/get/get-range). etag is STABLE per key (R2 does
// not drift mid-fetch); bodies are Buffers (shard .bin) or strings (json).
function makeStore() {
    const map = new Map();
    let seq = 0;
    const put = (key, body) => {
        const bytes = typeof body === 'string'
            ? new TextEncoder().encode(body)
            : new Uint8Array(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength ?? body.length);
        map.set(key, { bytes, etag: `etag-${++seq}` });
    };
    const client = { send(cmd) { put(cmd.input.Key, cmd.input.Body); return Promise.resolve({}); } };
    const slab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const bucket = {
        async head(key) { const o = map.get(key); return o ? { size: o.bytes.byteLength, etag: o.etag } : null; },
        async get(key, opts) {
            const o = map.get(key);
            if (!o) return null;
            if (opts?.range) {
                const s = o.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length);
                return { etag: o.etag, async arrayBuffer() { return slab(s); } };
            }
            return { etag: o.etag, async arrayBuffer() { return slab(o.bytes); } };
        },
    };
    return { client, bucket, put };
}

function gzipSync(text) { return require('zlib').gzipSync(Buffer.from(text, 'utf-8')); }

async function publishFixture(lines) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neg-filtered-'));
    const file = path.join(dir, 'neg-evidence.jsonl');
    await fs.writeFile(file, lines.join('\n'));
    const store = makeStore();
    // This is a v1 worker-serving parity test: it reads back via the legacy
    // date-derived keys, so the producer writes to the date-only object_prefix.
    await publishNegShards({ client: store.client, bucket: 'b', jsonlPath: file, snapshotDate: DATE, outputRoot: path.join(dir, 'snapshots'), objectPrefix: `snapshots/${DATE}/` });
    store.put('snapshots/latest.json', JSON.stringify({ latest_snapshot_date: DATE, neg_evidence_manifest_key: `snapshots/${DATE}/neg-evidence/` }));
    return { dir, store };
}

function makeLegacyStore(lines) {
    const store = makeStore();
    store.put('snapshots/latest.json', JSON.stringify({ latest_snapshot_date: DATE })); // NO manifest key -> legacy
    store.put(`snapshots/${DATE}/neg-evidence.jsonl.gz`, gzipSync(lines.join('\n')));
    return store;
}

async function collectAllFiltered(bucket, filter, limit) {
    const ids = [];
    let offset = 0, guard = 0;
    for (;;) {
        const r = await loadNegEvidenceForCompound(bucket, COMPOUND, BASE, filter, { offset, limit });
        for (const s of r.signals) ids.push(s.id);
        if (!r.pagination.has_more) break;
        expect(r.pagination.next_offset).toBe(offset + r.signals.length);
        offset = r.pagination.next_offset;
        if (++guard > 1000) throw new Error('pagination did not terminate');
    }
    return ids;
}

describe('neg sharded path — event_type-FILTERED serving', () => {
    it('filtered count + signals + severity breakdown + by-type are all FILTERED', async () => {
        const { dir, store } = await publishFixture(buildFixture().lines);
        const { counts } = buildFixture();
        const r = await loadNegEvidenceForCompound(store.bucket, COMPOUND, BASE, parseEventTypeFilter('trial_failure'), { offset: 0, limit: DEFAULT_PAGE_LIMIT });
        expect(r.negative_signals_count).toBe(counts.trial_failure); // 80, NOT the unfiltered 120
        expect(r.negative_signals_count).not.toBe(120);
        expect(r.pagination.has_more).toBe(true); // 80 > 50 default page
        expect(r.signals.length).toBe(DEFAULT_PAGE_LIMIT);
        for (const s of r.signals) expect(s.evidence_type).toBe('trial_failure');
        expect(Object.keys(r.signals_by_evidence_type)).toEqual(['trial_failure']);
        expect(r.signals_by_evidence_type.trial_failure).toBe(counts.trial_failure);
        // trial_failure alternates critical/major over 80 -> 40 critical + 40 major.
        expect(r.signals_by_severity).toEqual({ critical: 40, major: 40, minor: 0, unknown: 0 });
        await fs.rm(dir, { recursive: true });
    });

    it('paging the FILTERED set to completion collects EXACTLY the filtered set (no dup/skip)', async () => {
        const { dir, store } = await publishFixture(buildFixture().lines);
        const ids = await collectAllFiltered(store.bucket, parseEventTypeFilter('trial_failure'), 17);
        expect(ids.length).toBe(80);
        expect(new Set(ids).size).toBe(80); // no duplicates
        for (const id of ids) expect(id.includes('::trial_failure::')).toBe(true); // bb ids never leak
        await fs.rm(dir, { recursive: true });
    });

    it('SHARDED filtered result == LEGACY filtered result for the same fixture (parity)', async () => {
        const { lines } = buildFixture();
        const { dir, store } = await publishFixture(lines);
        const legacy = makeLegacyStore(lines);
        const f = parseEventTypeFilter('black_box_warning');
        const sharded = await loadNegEvidenceForCompound(store.bucket, COMPOUND, BASE, f, { offset: 0, limit: 200 });
        const leg = await loadNegEvidenceForCompound(legacy.bucket, COMPOUND, BASE, f, { offset: 0, limit: 200 });
        expect(sharded.negative_signals_count).toBe(leg.negative_signals_count);
        expect(sharded.signals_by_severity).toEqual(leg.signals_by_severity);
        expect(sharded.signals_by_evidence_type).toEqual(leg.signals_by_evidence_type);
        expect(sharded.verdict.highest_severity).toBe(leg.verdict.highest_severity);
        // Same id SET (legacy = file order, sharded = (key,id)-sorted page order).
        expect(new Set(sharded.signals.map(s => s.id))).toEqual(new Set(leg.signals.map(s => s.id)));
        expect(sharded.signals.length).toBe(leg.signals.length);
        for (const s of sharded.signals) expect(s.evidence_type).toBe('black_box_warning');
        await fs.rm(dir, { recursive: true });
    });

    it('all-unknown filter Set serves the filtered-empty (NOT the unfiltered set)', async () => {
        const { dir, store } = await publishFixture(buildFixture().lines);
        const r = await loadNegEvidenceForCompound(store.bucket, COMPOUND, BASE, parseEventTypeFilter('not_a_real_type'), { offset: 0, limit: DEFAULT_PAGE_LIMIT });
        expect(r.negative_signals_count).toBe(0);
        expect(r.signals.length).toBe(0);
        expect(r.pagination.has_more).toBe(false);
        expect(r.signals_by_severity).toEqual({ critical: 0, major: 0, minor: 0, unknown: 0 });
        await fs.rm(dir, { recursive: true });
    });

    it('UNFILTERED request still reports the full unfiltered total + rollups (preserved)', async () => {
        const { dir, store } = await publishFixture(buildFixture().lines);
        const { counts } = buildFixture();
        const r = await loadNegEvidenceForCompound(store.bucket, COMPOUND, BASE, null, { offset: 0, limit: 200 });
        expect(r.negative_signals_count).toBe(120);
        expect(r.signals_by_evidence_type.trial_failure).toBe(counts.trial_failure);
        expect(r.signals_by_evidence_type.black_box_warning).toBe(counts.black_box_warning);
        expect(r.signals.length).toBe(120);
        await fs.rm(dir, { recursive: true });
    });
});
