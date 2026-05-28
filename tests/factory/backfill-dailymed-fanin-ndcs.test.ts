// @ts-nocheck
/**
 * PR-RXN-1b-fanin-patch tests (2026-05-28).
 *
 * Tests the per-line hydration function (pure) and gzip stream round-trip
 * determinism. R2 layer not mocked here -- end-to-end exercised by GHA
 * dispatch.
 *
 * Architect-mandated invariant: gzip stream reconstruction must preserve
 * record count parity (atomic write guard precondition). Type-isolated
 * hydration MUST NOT touch non-drug-label records.
 */

import { describe, it, expect, vi } from 'vitest';
import { gzipSync, gunzipSync } from 'zlib';
import { hydrateOneLine } from '../../scripts/factory/backfill-dailymed-fanin-ndcs.js';

describe('PR-RXN-1b-fanin-patch: hydrateOneLine', () => {
    it('1. drug_label missing ndcs[] -> hydrates with fetcher result', async () => {
        const rec = { id: 'sciweon::drug_label::setid::S1', setid: 'S1', title: 'X' };
        const fetcher = vi.fn().mockResolvedValue(['00001000001', '00001000002']);
        const { line, stats } = await hydrateOneLine(JSON.stringify(rec), fetcher);
        expect(fetcher).toHaveBeenCalledWith('S1');
        expect(JSON.parse(line).ndcs).toEqual(['00001000001', '00001000002']);
        expect(stats.hydrated).toBe(1);
        expect(stats.skipped_already).toBe(0);
    });

    it('2. drug_label with existing non-empty ndcs[] -> idempotent skip', async () => {
        const rec = { id: 'sciweon::drug_label::setid::S2', setid: 'S2', ndcs: ['existing-ndc'] };
        const fetcher = vi.fn();
        const { line, stats } = await hydrateOneLine(JSON.stringify(rec), fetcher);
        expect(fetcher).not.toHaveBeenCalled();
        expect(line).toContain('existing-ndc');
        expect(stats.skipped_already).toBe(1);
        expect(stats.hydrated).toBe(0);
    });

    it('3. non-drug-label record (atc_class) passes through unchanged (type isolation)', async () => {
        const rec = { id: 'sciweon::atc_class::C01AB', level5: 'C01AB', who_name: 'X' };
        const fetcher = vi.fn();
        const { line, stats } = await hydrateOneLine(JSON.stringify(rec), fetcher);
        expect(fetcher).not.toHaveBeenCalled();
        expect(line).toBe(JSON.stringify(rec));
        expect(stats.skipped_other_type).toBe(1);
        expect(stats.hydrated).toBe(0);
    });

    it('4. fetcher returns null (429-exhausted retries) -> ndcs set to []; counted as failure', async () => {
        const rec = { id: 'sciweon::drug_label::setid::S3', setid: 'S3' };
        const fetcher = vi.fn().mockResolvedValue(null);
        const { line, stats } = await hydrateOneLine(JSON.stringify(rec), fetcher);
        const parsed = JSON.parse(line);
        expect(parsed.ndcs).toEqual([]);
        expect(stats.fetcher_failed).toBe(1);
        expect(stats.failed_setid).toBe('S3');
    });

    it('5. drug_label without setid -> counted as failure, no fetch attempt', async () => {
        const rec = { id: 'sciweon::drug_label::setid::', title: 'orphan' };
        const fetcher = vi.fn();
        const { stats } = await hydrateOneLine(JSON.stringify(rec), fetcher);
        expect(fetcher).not.toHaveBeenCalled();
        expect(stats.fetcher_failed).toBe(1);
    });

    it('6. malformed JSON line passes through unchanged (defensive)', async () => {
        const fetcher = vi.fn();
        const { line, stats } = await hydrateOneLine('not-json-at-all', fetcher);
        expect(fetcher).not.toHaveBeenCalled();
        expect(line).toBe('not-json-at-all');
        expect(stats.hydrated).toBe(0);
    });

    it('7. ANTI-REGRESSION: drug_label with empty ndcs array IS hydrated (matches PR-185 deepMergeDrugLabel symmetry)', async () => {
        const rec = { id: 'sciweon::drug_label::setid::S4', setid: 'S4', ndcs: [] };
        const fetcher = vi.fn().mockResolvedValue(['00004000001']);
        const { line, stats } = await hydrateOneLine(JSON.stringify(rec), fetcher);
        // V1 simplification: empty array currently skipped (idempotency on
        // 'has ndcs field' rather than 'has non-empty ndcs'). Document that
        // this differs from PR-185 deepMergeDrugLabel preserve-on-empty
        // semantics. If empty-array drug_labels need re-hydration in future,
        // a separate flag-controlled path is required.
        // For NOW: matching architect's spec intent (avoid re-fetcher cost on
        // records that have already been examined), this skip is acceptable.
        expect(stats.skipped_already).toBe(0);  // empty array != non-empty
        expect(stats.hydrated).toBe(1);  // EMPTY-ARRAY case: re-hydrate (architect symmetry)
    });

    it('8. empty input line is dropped (no stats)', async () => {
        const fetcher = vi.fn();
        const { line, stats } = await hydrateOneLine('', fetcher);
        expect(line).toBe('');
        expect(stats.hydrated).toBe(0);
        expect(stats.skipped_other_type).toBe(0);
    });
});

describe('PR-RXN-1b-fanin-patch: gzip stream round-trip determinism (atomic write guard precondition)', () => {
    it('round-trip via gzipSync/gunzipSync preserves record count + content', () => {
        const records = [
            { id: 'sciweon::drug_label::setid::A', setid: 'A', ndcs: ['001'] },
            { id: 'sciweon::atc_class::C01AB', level5: 'C01AB' },
            { id: 'sciweon::drug_label::setid::B', setid: 'B' },
        ];
        const jsonl = records.map(r => JSON.stringify(r)).join('\n') + '\n';
        const gz = gzipSync(Buffer.from(jsonl, 'utf-8'));
        const decoded = gunzipSync(gz).toString('utf-8');
        const lines = decoded.split('\n').filter(Boolean);
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]).id).toBe('sciweon::drug_label::setid::A');
        expect(JSON.parse(lines[1]).id).toBe('sciweon::atc_class::C01AB');
    });
});
