// @ts-nocheck
/**
 * PR-COMPOUND-GUARD (Step-5a) — stage-4 pre-swap projection presence probe.
 *
 * The orchestrator process.exit(12)s (refuses to activate latest.json) when
 * either compound serving projection .gz key is absent under the candidate
 * object_prefix (RK-15 PR-B). The presence logic is extracted into
 * compoundProjectionsPresent() so it is unit-testable without the 90s drain + S3
 * publish. A 404 head() = missing; a transient/auth head() error PROPAGATES (the
 * orchestrator treats it as a refusal too -> exit 12, never a silent swap).
 */

import { describe, it, expect } from 'vitest';
import { compoundProjectionsPresent } from '../../scripts/factory/lib/stage-4-shard-orchestrator.js';

// RK-15 PR-B: keys are derived relative to the immutable object_prefix
// `snapshots/<date>/<run_id>-<attempt>/`, NOT a date-only prefix.
const PREFIX = 'snapshots/2026-06-06/12345-1/';
const SEARCH_KEY = `${PREFIX}compounds-search.jsonl.gz`;
const XREF_KEY = `${PREFIX}xref-index.json.gz`;

// Mock S3 client: present[] lists the keys that resolve a HeadObjectCommand.
function mockClient(present: string[], throwOn?: string) {
    return {
        async send(cmd: any) {
            const key = cmd.input.Key;
            if (throwOn && key === throwOn) {
                const e: any = new Error('transient');
                e.$metadata = { httpStatusCode: 500 };
                throw e;
            }
            if (present.includes(key)) return {};
            const e: any = new Error('NotFound');
            e.name = 'NotFound';
            e.$metadata = { httpStatusCode: 404 };
            throw e;
        },
    };
}

describe('compoundProjectionsPresent (stage-4 pre-swap probe)', () => {
    it('ok=true when BOTH projection .gz keys exist', async () => {
        const r = await compoundProjectionsPresent(mockClient([SEARCH_KEY, XREF_KEY]), 'b', PREFIX);
        expect(r.ok).toBe(true);
        expect(r.missing).toEqual([]);
    });

    it('reports the missing key when compounds-search.jsonl.gz is absent', async () => {
        const r = await compoundProjectionsPresent(mockClient([XREF_KEY]), 'b', PREFIX);
        expect(r.ok).toBe(false);
        expect(r.missing).toContain(SEARCH_KEY);
    });

    it('reports the missing key when xref-index.json.gz is absent', async () => {
        const r = await compoundProjectionsPresent(mockClient([SEARCH_KEY]), 'b', PREFIX);
        expect(r.ok).toBe(false);
        expect(r.missing).toContain(XREF_KEY);
    });

    it('both missing -> ok=false, both listed', async () => {
        const r = await compoundProjectionsPresent(mockClient([]), 'b', PREFIX);
        expect(r.ok).toBe(false);
        expect(r.missing).toEqual([SEARCH_KEY, XREF_KEY]);
    });

    it('a transient/auth head() error PROPAGATES (not mis-read as absence)', async () => {
        await expect(
            compoundProjectionsPresent(mockClient([XREF_KEY], SEARCH_KEY), 'b', PREFIX),
        ).rejects.toThrow(/transient/);
    });
});
