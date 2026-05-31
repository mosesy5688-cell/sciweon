/**
 * Tests for the DailyMed cross-link SSoT (PR-RXN-1g) -- lib/dailymed-crosslink.js.
 *
 * Locks the join semantics shared by the F2 increment linker (adapter-cross-
 * linker.js) and the F3 cumulative re-link (aggregated-backfill-enrich.js):
 *   - 4-field summary shape (parity guard vs the pre-extraction inline build)
 *   - scalar-or-array rxcui normalization
 *   - overwrite-ONLY-on-match (never blind-clears prior drug_labels --
 *     [[cross_cycle_silent_data_loss]])
 *   - idempotent re-run (overwrite, not append/double)
 */

import { describe, it, expect } from 'vitest';
import {
    buildDailymedByRxcui,
    linkCompoundsToDailymed,
    relinkCumulativeDailymed,
    classifyDailymedRxcuiBuckets,
} from '../../scripts/factory/lib/dailymed-crosslink.js';

function label(setid: string, rxcui: string[], opts: Record<string, unknown> = {}) {
    return {
        id: `sciweon::drug_label::setid::${setid}`,
        setid,
        rxcui,
        title: opts.title ?? `Label ${setid}`,
        has_boxed_warning: opts.has_boxed_warning ?? false,
        published_date: opts.published_date ?? '2026-05-20',
        ndcs: opts.ndcs,
    };
}

function compound(cid: number, rxcui: unknown, extra: Record<string, unknown> = {}) {
    return { id: `sciweon::compound::CID:${cid}`, external_ids: { rxcui }, ...extra };
}

describe('buildDailymedByRxcui', () => {
    it('builds rxcui -> 4-field summary[] with title sliced to 200 chars', () => {
        const longTitle = 'X'.repeat(250);
        const map = buildDailymedByRxcui([
            label('aaa', ['111'], { title: longTitle, has_boxed_warning: true, published_date: '2026-01-01' }),
        ]);
        expect(map.get('111')).toEqual([
            { setid: 'aaa', title: 'X'.repeat(200), has_boxed_warning: true, published_date: '2026-01-01' },
        ]);
    });

    it('indexes one label under each of its rxcuis and groups multiple labels per rxcui', () => {
        const map = buildDailymedByRxcui([
            label('a', ['111', '222']),
            label('b', ['111']),
        ]);
        expect(map.get('111')).toHaveLength(2);
        expect(map.get('222')).toHaveLength(1);
    });

    it('skips non-drug_label records and tolerates missing rxcui / bad input', () => {
        const map = buildDailymedByRxcui([
            { id: 'sciweon::atc_class::A01', rxcui: ['999'] },
            { id: 'sciweon::drug_label::setid::c' },               // no rxcui
            null,
        ] as never);
        expect(map.has('999')).toBe(false);
        expect(map.size).toBe(0);
    });
});

describe('linkCompoundsToDailymed', () => {
    const map = buildDailymedByRxcui([label('a', ['111']), label('b', ['222'])]);

    it('attaches summaries on a single-rxcui hit', () => {
        const c = compound(1, ['111']);
        const { dmLinked } = linkCompoundsToDailymed([c], map);
        expect(dmLinked).toBe(1);
        expect((c as any).drug_labels).toHaveLength(1);
        expect((c as any).drug_labels[0].setid).toBe('a');
    });

    it('unions summaries across multiple rxcuis', () => {
        const c = compound(2, ['111', '222']);
        linkCompoundsToDailymed([c], map);
        expect((c as any).drug_labels.map((l: any) => l.setid).sort()).toEqual(['a', 'b']);
    });

    it('normalizes a scalar (non-array) rxcui', () => {
        const c = compound(3, '111');
        const { dmLinked } = linkCompoundsToDailymed([c], map);
        expect(dmLinked).toBe(1);
        expect((c as any).drug_labels[0].setid).toBe('a');
    });

    it('leaves drug_labels ABSENT on a no-rxcui compound (does not set [])', () => {
        const c = compound(4, undefined);
        linkCompoundsToDailymed([c], map);
        expect('drug_labels' in (c as any)).toBe(false);
    });

    it('NEVER blind-clears: a prior drug_labels survives a non-match this pass', () => {
        const c = compound(5, ['000'], { drug_labels: [{ setid: 'historical', title: 'old' }] });
        const { dmLinked } = linkCompoundsToDailymed([c], map);
        expect(dmLinked).toBe(0);
        expect((c as any).drug_labels).toEqual([{ setid: 'historical', title: 'old' }]);
    });

    it('is idempotent: a second run overwrites, never doubling the array', () => {
        const c = compound(6, ['111']);
        linkCompoundsToDailymed([c], map);
        linkCompoundsToDailymed([c], map);
        expect((c as any).drug_labels).toHaveLength(1);
    });
});

describe('relinkCumulativeDailymed', () => {
    it('links cumulative compounds via already-populated label rxcui (null bulkMaps -> rehydrated=0)', () => {
        const compounds = [compound(1, ['111']), compound(2, ['nomatch'])];
        const labels = [label('a', ['111'])];
        const r = relinkCumulativeDailymed(compounds, labels, null);
        expect(r).toMatchObject({ dmLinked: 1, labelsRehydrated: 0, dmByRxcuiSize: 1 });
        expect((compounds[0] as any).drug_labels[0].setid).toBe('a');
        expect('drug_labels' in (compounds[1] as any)).toBe(false);
    });

    it('rehydrates label rxcui[] from ndcs[] via the bulk Map before the join', () => {
        const bulkMaps = {
            uniiToRxcui: new Map(),
            ndcToRxcuis: new Map([['00001000001', new Set([{ rxcui: '111', preferred_str: 'x', tty: 'IN' }])]]),
        };
        // Label has ndcs but empty rxcui -> rehydration should populate rxcui=111.
        const labels = [label('a', [], { ndcs: ['00001000001'] })];
        const compounds = [compound(1, ['111'])];
        const r = relinkCumulativeDailymed(compounds, labels, bulkMaps as never);
        expect(r.labelsRehydrated).toBe(1);
        expect(r.dmLinked).toBe(1);
        expect((compounds[0] as any).drug_labels[0].setid).toBe('a');
    });
});

describe('classifyDailymedRxcuiBuckets', () => {
    const maps = (pairs: [string, string][]) => ({
        uniiToRxcui: new Map(pairs.map(([u, r]) => [u, { rxcui: r }])),
    });

    it('fail-soft: no bulkMaps -> reverse_map_available false + zeros, no throw', () => {
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const r = classifyDailymedRxcuiBuckets([compound(1, '111')], dm, null);
        expect(r.reverse_map_available).toBe(false);
        expect(r.total_label_rxcui).toBe(1);
        expect(r.productive).toBe(0);
    });

    it('productive: a compound carries the label rxcui', () => {
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const r = classifyDailymedRxcuiBuckets([compound(1, '111')], dm, maps([['UUUUUUUUU1', '111']]));
        expect(r.reverse_map_available).toBe(true);
        expect(r.productive).toBe(1);
    });

    it('in_corpus_unstamped: reverse-unii on a corpus compound with rxcui null (B2a self-check)', () => {
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const comp = compound(1, null, { external_ids: { unii: 'UUUUUUUUU1', rxcui: null } });
        const r = classifyDailymedRxcuiBuckets([comp], dm, maps([['UUUUUUUUU1', '111']]));
        expect(r.in_corpus_unstamped).toBe(1);
        expect(r.productive).toBe(0);
        expect(r.samples.in_corpus_unstamped[0]).toMatchObject({ rxcui: '111', unii: 'UUUUUUUUU1' });
    });

    it('in_corpus_stamp_drift: reverse-unii on a stamped compound with a different rxcui', () => {
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const comp = compound(1, '999', { external_ids: { unii: 'UUUUUUUUU1', rxcui: '999' } });
        const r = classifyDailymedRxcuiBuckets([comp], dm, maps([['UUUUUUUUU1', '111']]));
        expect(r.in_corpus_stamp_drift).toBe(1);
        expect(r.productive).toBe(0);
    });

    it('not_in_corpus: reverse-unii exists but no compound carries it (lever = expand corpus)', () => {
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const r = classifyDailymedRxcuiBuckets([compound(1, '222', { external_ids: { unii: 'OTHERUNII1', rxcui: '222' } })], dm, maps([['UUUUUUUUU1', '111']]));
        expect(r.not_in_corpus).toBe(1);
        expect(r.samples.not_in_corpus[0]).toMatchObject({ rxcui: '111', unii: 'UUUUUUUUU1' });
    });

    it('no_unii_bridge: label rxcui absent from inverted map', () => {
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const r = classifyDailymedRxcuiBuckets([compound(1, '222')], dm, maps([['UUUUUUUUU1', '999']]));
        expect(r.no_unii_bridge).toBe(1);
        expect(r.samples.no_unii_bridge[0]).toMatchObject({ rxcui: '111' });
    });

    it('PR-MD-1c.2: no_unii_bridge sample carries TTY from ndcToRxcuis (in-memory, no RXNCONSO re-read)', () => {
        // label rxcui 111 has no UNII (not in uniiToRxcui) but IS in ndcToRxcuis
        // with tty=SCD (product-level) -> structural-vs-scope becomes measurable.
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const bm = {
            uniiToRxcui: new Map([['UUUUUUUUU1', { rxcui: '999' }]]),
            ndcToRxcuis: new Map([['00001000001', new Set([{ rxcui: '111', tty: 'SCD' }])]]),
        };
        const r = classifyDailymedRxcuiBuckets([compound(1, '222')], dm, bm);
        expect(r.no_unii_bridge).toBe(1);
        expect(r.samples.no_unii_bridge[0]).toMatchObject({ rxcui: '111', tty: 'SCD', in_ndc_map: true });
    });

    it('PR-MD-1c.2: no_unii_bridge R absent from BOTH maps -> tty null, in_ndc_map false', () => {
        const dm = buildDailymedByRxcui([label('a', ['111'])]);
        const r = classifyDailymedRxcuiBuckets([compound(1, '222')], dm, maps([['UUUUUUUUU1', '999']]));
        expect(r.samples.no_unii_bridge[0]).toMatchObject({ rxcui: '111', tty: null, in_ndc_map: false });
    });

});
